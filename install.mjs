#!/usr/bin/env node
/**
 * 把 global-skills 下的技能安装到 DSH 用户级技能目录（默认 ~/.dsh/skills）。
 * 用户级目录对「任何项目」的 DSH 会话生效，不需要在每个项目里重复配置。
 *
 *   node install.mjs              # 安装/覆盖（覆盖前备份已有目录）
 *   node install.mjs --dry-run    # 只打印将要做什么
 *   node install.mjs --uninstall  # 移除本仓库安装的技能
 */

import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url))
const SKILLS = ['claw-doing', 'task-watchdog']

const argv = new Set(process.argv.slice(2))
const dryRun = argv.has('--dry-run')
const uninstall = argv.has('--uninstall')

const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? homedir(), '.dsh')
const targetRoot = join(dshHome, 'skills')

function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function main() {
  if (!(await exists(SOURCE_ROOT))) throw new Error(`源目录不存在：${SOURCE_ROOT}`)
  if (!dryRun) await mkdir(targetRoot, { recursive: true })
  console.log(`源目录：${SOURCE_ROOT}`)
  console.log(`目标：${targetRoot}${dryRun ? '（dry-run）' : ''}`)

  for (const name of SKILLS) {
    const source = join(SOURCE_ROOT, name)
    const target = join(targetRoot, name)
    if (!(await exists(source))) {
      console.log(`- ${name}：跳过（源目录缺失）`)
      continue
    }
    if (uninstall) {
      if (!(await exists(target))) {
        console.log(`- ${name}：未安装，跳过`)
        continue
      }
      if (!dryRun) await rm(target, { recursive: true, force: true })
      console.log(`- ${name}：已移除`)
      continue
    }
    if (await exists(target)) {
      const backup = `${target}.bak-${stamp()}`
      if (!dryRun) await rename(target, backup)
      console.log(`- ${name}：旧版本备份到 ${backup}`)
    }
    if (!dryRun) await cp(source, target, { recursive: true })
    console.log(`- ${name}：${dryRun ? '将安装' : '已安装'}`)
  }

  if (!uninstall && !dryRun) {
    const entries = await readdir(targetRoot, { withFileTypes: true })
    const installed = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    console.log(`\n当前用户级技能：${installed.sort().join(', ')}`)
    console.log('新开一个 DSH 会话即可在技能目录里看到它们；已有会话需要重开任务。')
  }
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exit(1)
})
