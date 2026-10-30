#!/usr/bin/env node
/**
 * claw-doing · DSH 版：只读快照，回答「我的 DSH agent 此刻在干什么」。
 *
 * DSH 把每个会话持久化为 zstd 压缩的 JSONL 帧序列：
 *   $DSH_HOME/sessions/<编码后的工作目录>/<会话 id>/session.v<N>.jsonl.zstd
 * 帧是顺序追加的，因此只要解码最近若干帧，就能在不接触 DSH 运行时的情况下
 * 还原出：当前步骤、正在跑的工具、未结束的后台任务、最后活动距今多久。
 *
 * 用法：
 *   node doing.mjs                      # 最近 10 个会话的总览
 *   node doing.mjs --all --limit 20     # 含 12 小时以前的会话
 *   node doing.mjs --watch 3            # 每 3 秒刷新（Ctrl-C 退出）
 *   node doing.mjs --json               # 机器可读输出
 *   node doing.mjs --session a4afdf62   # 某个会话的最近事件明细
 *
 * 退出码：0 正常；2 参数错误或找不到会话目录。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const DSH_HOME = process.env.DSH_HOME ?? join(process.env.HOME ?? homedir(), '.dsh')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
const SESSION_FILE = /^session\.v\d+\.jsonl\.zstd$/
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const MAX_FRAMES = 400
const ACTIVE_WINDOW_MS = 12 * 60 * 60 * 1000

const EVENT_LABELS = {
  'assistant/message': '模型思考中',
  'step/start': '等待模型',
  'step/end': '步骤结束',
  'tool/result': '工具返回，等模型',
  'user/message': '收到用户消息',
  'turn/start': '回合开始',
  'turn/end': '回合结束',
  'job/registered': '启动后台任务',
  'job/settled': '后台任务结束',
  'session/title': '生成会话标题',
  'approval/policy': '设置审批策略',
  'sandbox/mode': '设置沙箱模式',
  'permission/preset': '设置权限预设',
  'request/header': '准备模型请求',
  'request/context': '准备上下文',
  'system/message': '注入系统消息',
  'agent/inbox/spliced': '插入会话消息',
}

function parseArgs(argv) {
  const options = {
    all: false,
    json: false,
    limit: 10,
    idle: 120,
    stall: 300,
    watch: 0,
    session: undefined,
    events: 15,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`缺少 ${arg} 的参数值`)
      }
      i += 1
      return value
    }
    const num = (name) => {
      const value = Number(next())
      if (!Number.isFinite(value) || value < 0) throw new UsageError(`${name} 需要非负数字`)
      return value
    }
    switch (arg) {
      case '--all': options.all = true; break
      case '--json': options.json = true; break
      case '--limit': options.limit = Math.max(1, Math.trunc(num('--limit'))); break
      case '--idle': options.idle = num('--idle'); break
      case '--stall': options.stall = num('--stall'); break
      case '--events': options.events = Math.max(1, Math.trunc(num('--events'))); break
      case '--watch':
        options.watch = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? Math.max(1, num('--watch')) : 3
        break
      case '--session': options.session = next(); break
      case '--help':
      case '-h':
        console.log(HELP)
        process.exit(0)
        break
      default:
        throw new UsageError(`未知参数：${arg}`)
    }
  }
  return options
}

class UsageError extends Error {}

const HELP = `claw-doing · 查看 DSH agent 此刻在做什么

  node doing.mjs [选项]

  --all              包含 12 小时以前的会话
  --limit N          最多显示 N 个会话（默认 10）
  --idle N           最后活动不足 N 秒视为「运行中」（默认 120）
  --stall N          工具运行超过 N 秒标记为可疑卡住（默认 300）
  --watch [N]        每 N 秒刷新一次（默认 3，Ctrl-C 退出）
  --session <id>     显示某个会话的最近事件明细（id 前缀即可）
  --events N         明细模式显示 N 条事件（默认 15）
  --json             输出 JSON

数据来源：$DSH_HOME/sessions（只读，不需要 DSH 运行时）。`

function frameOffsets(buffer) {
  const offsets = []
  let index = buffer.indexOf(ZSTD_MAGIC)
  while (index >= 0) {
    offsets.push(index)
    index = buffer.indexOf(ZSTD_MAGIC, index + 4)
  }
  return offsets
}

function decodeTail(buffer) {
  const offsets = frameOffsets(buffer)
  const start = Math.max(0, offsets.length - MAX_FRAMES)
  let text = ''
  for (let i = start; i < offsets.length; i += 1) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length
    try {
      text += zstdDecompressSync(buffer.subarray(offsets[i], end)).toString('utf8')
    } catch {
      // 扫描到的魔数可能是压缩数据里的巧合字节：跳过解不出的片段。
    }
  }
  return text
}

function parseRecords(text) {
  const records = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // 末尾未写完的半行 JSON 直接跳过。
    }
  }
  return records
}

async function decodeSessionFile(file) {
  const info = await stat(file)
  if (info.size > 64 * 1024 * 1024) return { records: [], size: info.size }
  const buffer = await readFile(file)
  return { records: parseRecords(decodeTail(buffer)), size: info.size }
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h${minutes % 60}m`
}

function truncate(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1)}…`
}

function summarizeToolCall(name, rawArguments) {
  let args = {}
  try {
    args = rawArguments === undefined ? {} : JSON.parse(rawArguments)
  } catch {
    args = {}
  }
  if (args === null || typeof args !== 'object') args = {}
  const detail = args.command
    ?? args.file_path
    ?? args.path
    ?? args.url
    ?? args.pattern
    ?? args.query
    ?? args.description
    ?? args.task
    ?? args.message
    ?? ''
  const text = truncate(detail, 64)
  return text.length > 0 ? `${name} · ${text}` : name
}

function openJobsOf(records) {
  const jobs = new Map()
  for (const record of records) {
    const data = record.data ?? {}
    if (record.type === 'job/registered' && typeof data.jobId === 'string') {
      jobs.set(data.jobId, {
        jobId: data.jobId,
        kind: data.kind ?? 'job',
        label: data.label ?? '',
        startedAt: record.time,
      })
    } else if (record.type === 'job/settled' && typeof data.jobId === 'string') {
      jobs.delete(data.jobId)
    }
  }
  return [...jobs.values()]
}

function summarizeSession(entry, records, options) {
  const header = records.find((record) => record.type === 'session') ?? {}
  const timeline = records.filter((record) => typeof record.time === 'number')
  const last = timeline[timeline.length - 1]
  const now = Date.now()
  const lastAt = last?.time ?? entry.mtimeMs
  const ageMs = now - lastAt

  let currentTool
  for (const record of timeline) {
    if (record.type === 'tool/call') {
      currentTool = {
        callId: record.data?.callId,
        name: record.data?.name ?? 'tool',
        arguments: record.data?.arguments,
        startedAt: record.time,
        turn: record.data?.turn,
        step: record.data?.step,
      }
    } else if (record.type === 'tool/result' && currentTool?.callId === record.data?.toolCallId) {
      currentTool = undefined
    }
  }

  const openJobs = openJobsOf(timeline)
  const active = ageMs <= options.idle * 1000
  const unfinished = currentTool !== undefined && !active
  const stalled = unfinished && now - currentTool.startedAt > options.stall * 1000
  const status = active ? 'running' : stalled ? 'stalled' : 'idle'

  let activity
  if (openJobs.length > 0) {
    const job = openJobs[0]
    activity = `后台任务 ${job.kind} 运行 ${fmtDuration(now - job.startedAt)}${job.label ? ` · ${truncate(job.label, 56)}` : ''}`
  } else if (currentTool !== undefined) {
    activity = unfinished
      ? `上次调用未返回：${summarizeToolCall(currentTool.name, currentTool.arguments)}（已 ${fmtDuration(now - currentTool.startedAt)}；可能仍在运行，或会话已中断）`
      : `工具 ${summarizeToolCall(currentTool.name, currentTool.arguments)} · 已运行 ${fmtDuration(now - currentTool.startedAt)}`
  } else if (last !== undefined) {
    activity = EVENT_LABELS[last.type] ?? last.type
  } else {
    activity = '暂无事件'
  }

  const step = last?.data?.step
  const turn = last?.data?.turn

  return {
    sessionId: header.id ?? entry.sessionId,
    cwd: header.cwd ?? decodeProjectDir(entry.projectDir),
    status,
    ageMs,
    lastEventType: last?.type ?? '',
    lastEventAt: lastAt,
    activity,
    turn,
    step,
    openJobs,
    currentTool: currentTool === undefined ? undefined : { name: currentTool.name, startedAt: currentTool.startedAt },
    file: entry.file,
  }
}

function shortId(sessionId) {
  return String(sessionId ?? '').replace(/^session-/, '').slice(0, 8)
}

function decodeProjectDir(name) {
  // DSH 把工作目录编码成 --<路径转义>--，这里只做尽力还原，失败时原样返回。
  try {
    const inner = name.replace(/^--|--$/g, '')
    return inner.replace(/~([0-9A-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))).replace(/~0020/g, ' ')
  } catch {
    return name
  }
}

async function collectSessions() {
  let projectDirs = []
  try {
    projectDirs = await readdir(SESSIONS_ROOT, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') throw new UsageError(`找不到 DSH 会话目录：${SESSIONS_ROOT}`)
    throw error
  }
  const sessions = []
  for (const projectEntry of projectDirs) {
    if (!projectEntry.isDirectory()) continue
    const projectPath = join(SESSIONS_ROOT, projectEntry.name)
    let sessionDirs = []
    try {
      sessionDirs = await readdir(projectPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const sessionEntry of sessionDirs) {
      if (!sessionEntry.isDirectory()) continue
      const sessionPath = join(projectPath, sessionEntry.name)
      let files = []
      try {
        files = await readdir(sessionPath)
      } catch {
        continue
      }
      const file = files.find((name) => SESSION_FILE.test(name))
      if (file === undefined) continue
      const filePath = join(sessionPath, file)
      const info = await stat(filePath)
      sessions.push({
        file: filePath,
        mtimeMs: info.mtimeMs,
        projectDir: projectEntry.name,
        sessionId: sessionEntry.name,
      })
    }
  }
  sessions.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return sessions
}

async function loadEntries(options) {
  const sessions = await collectSessions()
  const cutoff = options.all ? 0 : Date.now() - ACTIVE_WINDOW_MS
  const recent = sessions.filter((entry) => entry.mtimeMs >= cutoff)
  return (recent.length > 0 ? recent : sessions).slice(0, options.limit)
}

async function renderOverview(options) {
  const entries = await loadEntries(options)
  const summaries = []
  for (const entry of entries) {
    const { records } = await decodeSessionFile(entry.file)
    summaries.push(summarizeSession(entry, records, options))
  }
  if (options.json) {
    console.log(JSON.stringify({ at: Date.now(), sessions: summaries }, null, 2))
    return
  }
  if (options.watch > 0) process.stdout.write('\u001b[2J\u001b[H')
  console.log(`claw-doing · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · ${summaries.length} 个最近会话${options.watch > 0 ? ` · 每 ${options.watch}s 刷新` : ''}`)
  if (summaries.length === 0) {
    console.log('没有可显示的会话。')
    return
  }
  const shortCwd = (cwd) => {
    const home = process.env.HOME ?? homedir()
    const text = String(cwd ?? '')
    return text.startsWith(home) ? `~${text.slice(home.length)}` : text
  }
  const tally = { running: 0, stalled: 0, idle: 0 }
  for (const item of summaries) tally[item.status] += 1
  console.log(`运行中 ${tally.running} · 可疑卡住 ${tally.stalled} · 空闲 ${tally.idle}`)
  for (const item of summaries) {
    const icon = item.status === 'running' ? '●' : item.status === 'stalled' ? '▲' : '○'
    const statusText = item.status === 'running' ? '运行中' : item.status === 'stalled' ? '可疑卡住' : '空闲'
    const progress = item.turn !== undefined && item.step !== undefined ? ` · turn ${item.turn} step ${item.step}` : ''
    console.log('')
    console.log(`${icon} ${statusText} · ${fmtDuration(item.ageMs)}前 · ${shortId(item.sessionId)}${progress}`)
    console.log(`  ${shortCwd(item.cwd)}`)
    console.log(`  ${item.activity}`)
  }
}

async function renderDetail(options) {
  const sessions = await collectSessions()
  const match = sessions.find((entry) => entry.sessionId.includes(options.session) || entry.sessionId.replace(/^session-/, '').startsWith(options.session))
  if (match === undefined) throw new UsageError(`找不到会话：${options.session}`)
  const { records } = await decodeSessionFile(match.file)
  const timeline = records.filter((record) => typeof record.time === 'number')
  const header = records.find((record) => record.type === 'session') ?? {}
  const slice = timeline.slice(-options.events)
  if (options.json) {
    console.log(JSON.stringify({ session: header.id ?? match.sessionId, cwd: header.cwd, events: slice }, null, 2))
    return
  }
  console.log(`会话 ${header.id ?? match.sessionId}`)
  console.log(`目录 ${header.cwd ?? decodeProjectDir(match.projectDir)}`)
  console.log(`创建 ${header.createdAt ? new Date(header.createdAt).toLocaleString('zh-CN', { hour12: false }) : '未知'} · 最近 ${fmtDuration(Date.now() - (timeline.at(-1)?.time ?? match.mtimeMs))}前`)
  console.log('')
  for (const record of slice) {
    const at = new Date(record.time).toLocaleTimeString('zh-CN', { hour12: false })
    const data = record.data ?? {}
    let summary = ''
    if (record.type === 'tool/call') summary = summarizeToolCall(data.name ?? 'tool', data.arguments)
    else if (record.type === 'user/message') summary = truncate(data.message?.content?.[0]?.text ?? data.text ?? '', 80)
    else if (record.type === 'assistant/message') summary = truncate((data.message?.content ?? []).map((part) => part.text ?? part.name ?? '').filter(Boolean).join(' '), 80)
    else if (record.type === 'tool/result') summary = truncate(data.message?.content?.[0]?.text ?? '', 80)
    else if (record.type === 'job/registered') summary = `${data.kind ?? 'job'} · ${truncate(data.label ?? '', 60)}`
    else if (record.type === 'job/settled') summary = `${data.status ?? 'settled'} · ${fmtDuration((data.finishedAt ?? 0) - (data.startedAt ?? 0))} · ${truncate(data.label ?? '', 40)}`
    else summary = Object.keys(data).slice(0, 3).join(', ')
    console.log(`${at}  ${record.type.padEnd(24)}  ${summary}`)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.session !== undefined) {
    await renderDetail(options)
    return
  }
  if (options.watch > 0) {
    for (;;) {
      try {
        await renderOverview(options)
      } catch (error) {
        if (error instanceof UsageError) throw error
        console.error(`刷新失败：${error.message}`)
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, options.watch) * 1000))
    }
  }
  await renderOverview(options)
}

main().catch((error) => {
  console.error(error instanceof UsageError ? error.message : error)
  process.exit(error instanceof UsageError ? 2 : 1)
})
