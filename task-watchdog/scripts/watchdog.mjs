#!/usr/bin/env node
/**
 * task-watchdog · DSH 版：包装一条可能卡住的长命令，偏离预期时报警并做有界清理。
 *
 * 监督三类偏离：
 *   1. 输出空闲（--idle，默认 300s）：子进程很久没有新输出，视为卡死；
 *   2. 总时长超限（--timeout，默认 3600s）；
 *   3. 致命输出（--fail-on REGEX，可重复）：命中即判失败。
 * 触发后先发通知（macOS），再对进程组发 SIGTERM，宽限 --grace 秒后 SIGKILL，
 * 最后输出结构化报告并写报告文件。子进程放在独立进程组里，因此 npm/构建脚本
 * 派生出的孙子进程会被一起清掉。
 *
 * 用法：
 *   node watchdog.mjs --idle 300 --timeout 3600 -- npm run build
 *   node watchdog.mjs --fail-on 'FATAL|panic:' -- sh -c 'make test 2>&1 | tee build.log'
 *
 * 退出码：0 成功；1 失败；124 超时；42 输出空闲（卡死）；43 命中致命输出；
 *         2 参数错误。
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXIT = { success: 0, failed: 1, timeout: 124, stalled: 42, fatal: 43, usage: 2 }
const HELP = `task-watchdog · 长任务看门狗

  node watchdog.mjs [选项] -- <命令> [参数...]

  --idle SEC       无输出多久判卡死（默认 300）
  --timeout SEC    总时长上限（默认 3600）
  --grace SEC      终止宽限：SIGTERM 后等多久再 SIGKILL（默认 10）
  --interval SEC   检查间隔（默认 5）
  --fail-on REGEX  输出命中该正则即判失败（可重复）
  --log-dir DIR    日志与报告目录（默认 $TMPDIR/dsh-watchdog）
  --tail N         报告里保留最后 N 行输出（默认 20）
  --quiet          不回显子进程输出（仍写日志）
  --no-notify      触发时不发系统通知（默认发）
  -h, --help       显示帮助

示例：
  node watchdog.mjs --idle 180 -- pnpm build
  node watchdog.mjs --timeout 600 --fail-on 'ENOMEM' -- sh -c 'npm test'

报告：stdout 末尾的 JSON；文件写在 --log-dir 下。`

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    idle: 300,
    timeout: 3600,
    grace: 10,
    interval: 5,
    failOn: [],
    logDir: join(process.env.TMPDIR ?? tmpdir(), 'dsh-watchdog'),
    tail: 20,
    quiet: false,
    notify: true,
    command: [],
  }
  let index = 0
  for (; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      index += 1
      break
    }
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined) throw new UsageError(`缺少 ${arg} 的参数值`)
      index += 1
      return next
    }
    const seconds = (name) => {
      const parsed = Number(value())
      if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError(`${name} 需要正数秒`)
      return parsed
    }
    switch (arg) {
      case '--idle': options.idle = seconds('--idle'); break
      case '--timeout': options.timeout = seconds('--timeout'); break
      case '--grace': options.grace = seconds('--grace'); break
      case '--interval': options.interval = seconds('--interval'); break
      case '--fail-on': options.failOn.push(new RegExp(value())); break
      case '--log-dir': options.logDir = value(); break
      case '--tail': options.tail = Math.max(0, Math.trunc(Number(value()))); break
      case '--quiet': options.quiet = true; break
      case '--no-notify': options.notify = false; break
      case '-h':
      case '--help':
        console.log(HELP)
        process.exit(0)
        break
      default:
        throw new UsageError(`未知参数：${arg}（命令请放在 -- 之后）`)
    }
  }
  options.command = argv.slice(index)
  if (options.command.length === 0) throw new UsageError('缺少要执行的命令（放在 -- 之后）')
  return options
}

function stamp() {
  const now = new Date()
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function fmtDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h${minutes % 60}m`
}

function notify(title, message) {
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`
  const child = spawn('osascript', ['-e', script], { stdio: 'ignore' })
  child.on('error', () => {})
}

function killGroup(pid, signal) {
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // 进程已经退出：无需再清理。
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  await mkdir(options.logDir, { recursive: true })

  const [file, ...args] = options.command
  const logFile = join(options.logDir, `watchdog-${stamp()}-${process.pid}.log`)
  const reportFile = logFile.replace(/\.log$/, '.report.json')
  const startedAt = Date.now()
  const tail = []
  let outputLines = 0
  let lastOutputAt = startedAt

  await writeFile(logFile, `# command: ${options.command.join(' ')}\n# started: ${new Date(startedAt).toISOString()}\n`, 'utf8')

  const child = spawn(file, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })

  const onChunk = (stream) => (chunk) => {
    const text = chunk.toString('utf8')
    outputLines += text.split('\n').length - 1
    lastOutputAt = Date.now()
    void appendFile(logFile, text).catch(() => {})
    if (!options.quiet) stream.write(text)
    if (options.failOn.length > 0) {
      for (const line of text.split('\n')) {
        if (line.length === 0) continue
        for (const pattern of options.failOn) {
          pattern.lastIndex = 0
          if (pattern.test(line)) {
            trigger('fatal', `命中致命输出：${line.trim().slice(0, 160)}`)
            return
          }
        }
      }
    }
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      tail.push(line)
      if (tail.length > options.tail) tail.shift()
    }
  }
  child.stdout.on('data', onChunk(process.stdout))
  child.stderr.on('data', onChunk(process.stderr))

  const timers = []
  let triggered
  let triggering = false

  const clearTimers = () => {
    for (const timer of timers) clearInterval(timer)
    timers.length = 0
  }

  const trigger = (reason, detail) => {
    if (triggered !== undefined || triggering) return
    triggering = true
    triggered = { reason, detail, at: Date.now() }
    const pretty = reason === 'timeout' ? '总时长超限' : reason === 'stalled' ? '输出空闲' : reason === 'fatal' ? '致命输出' : '失败'
    console.log(`\n[watchdog] ${pretty}：${detail}`)
    if (options.notify) notify(`task-watchdog · ${pretty}`, detail)
    killGroup(child.pid, 'SIGTERM')
    const killer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        console.log('[watchdog] 宽限期已过，发送 SIGKILL')
        killGroup(child.pid, 'SIGKILL')
      }
    }, options.grace * 1000)
    timers.push(killer)
  }

  check()
  function check() {
    const now = Date.now()
    const sinceOutput = now - lastOutputAt
    if (sinceOutput > options.idle * 1000) {
      trigger('stalled', `${fmtDuration(sinceOutput)} 没有新输出（阈值 ${options.idle}s）`)
      return
    }
    const elapsed = now - startedAt
    if (elapsed > options.timeout * 1000) {
      trigger('timeout', `已运行 ${fmtDuration(elapsed)}（上限 ${options.timeout}s）`)
    }
  }

  const interval = setInterval(check, Math.max(1, options.interval) * 1000)
  timers.push(interval)

  const forwardSignal = (signal) => {
    if (triggered === undefined) {
      triggered = { reason: 'signal', detail: `收到 ${signal}`, at: Date.now() }
      triggering = true
    }
    killGroup(child.pid, signal)
  }
  process.on('SIGINT', () => forwardSignal('SIGINT'))
  process.on('SIGTERM', () => forwardSignal('SIGTERM'))

  const exit = await new Promise((resolve) => {
    child.on('error', (error) => resolve({ error }))
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
  clearTimers()
  const finishedAt = Date.now()
  const durationMs = finishedAt - startedAt
  const lastOutputAgoMs = finishedAt - lastOutputAt

  const statusOf = () => {
    if (triggered?.reason === 'stalled') return 'stalled'
    if (triggered?.reason === 'timeout') return 'timeout'
    if (triggered?.reason === 'fatal') return 'fatal'
    if (triggered?.reason === 'signal') return 'failed'
    if (exit.error !== undefined) return 'failed'
    return exit.code === 0 ? 'success' : 'failed'
  }
  const status = statusOf()
  const reason = triggered?.detail
    ?? (exit.error !== undefined ? exit.error.message : status === 'success' ? '命令正常结束' : `退出码 ${exit.code}`)

  const report = {
    status,
    command: options.command,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs,
    lastOutputAgoMs,
    outputLines,
    exitCode: exit.code ?? null,
    signal: exit.signal ?? null,
    reason,
    thresholds: { idleSeconds: options.idle, timeoutSeconds: options.timeout },
    logFile,
    reportFile,
    tail,
  }
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  const label = { success: '成功', failed: '失败', stalled: '卡死', timeout: '超时', fatal: '致命输出' }[status]
  const exitText = exit.signal !== null && exit.signal !== undefined ? `信号 ${exit.signal}` : exit.code === null || exit.code === undefined ? '' : `退出码 ${exit.code}`
  const detailText = triggered !== undefined ? reason : exit.error !== undefined ? exit.error.message : ''
  console.log(`\n[watchdog] 状态：${label} · 耗时 ${fmtDuration(durationMs)}${exitText ? ` · ${exitText}` : ''}${detailText ? ` · ${detailText}` : ''}`)
  console.log(`[watchdog] 日志：${logFile}`)
  console.log(`[watchdog] 报告：${JSON.stringify(report)}`)

  process.exitCode = EXIT[status] ?? 1
}

main().catch((error) => {
  console.error(error instanceof UsageError ? error.message : error)
  process.exit(EXIT.usage)
})
