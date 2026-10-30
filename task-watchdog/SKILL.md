---
name: task-watchdog
description: 长任务看门狗：把一条可能卡死、超时或刷出致命错误的命令交给守护脚本运行，监督输出空闲、总时长和致命输出，触发后发系统通知、按进程组有界清理并给出结构化报告。用于构建、安装、下载、测试、批量转换等长任务，或用户要求「盯着别卡死 / 超时自动停 / 挂机跑完告诉我」。
---

# task-watchdog · 长任务看门狗

比 `timeout` 多三件事：按**输出空闲**判卡死（不是只看总时长）、命中关键错误立即止损、清理整棵进程树并留可交接的报告。

## 用法

```sh
node ~/.dsh/skills/task-watchdog/scripts/watchdog.mjs --idle 300 -- pnpm build
node ~/.dsh/skills/task-watchdog/scripts/watchdog.mjs --timeout 1800 --fail-on 'FATAL|ENOMEM' -- sh -c 'make test 2>&1 | tee build.log'
```

参数：

| 参数 | 默认 | 含义 |
|---|---|---|
| `--idle SEC` | 300 | 连续多久没有新输出判卡死 |
| `--timeout SEC` | 3600 | 总时长上限 |
| `--grace SEC` | 10 | SIGTERM 后等多久再 SIGKILL |
| `--interval SEC` | 5 | 检查间隔 |
| `--fail-on REGEX` | — | 输出命中即判失败，可重复 |
| `--log-dir DIR` | `$TMPDIR/dsh-watchdog` | 日志与报告目录 |
| `--tail N` | 20 | 报告保留最后 N 行输出 |
| `--quiet` | 关 | 不回显子进程输出（仍写日志） |
| `--no-notify` | 关 | 不弹 macOS 通知 |

命令放在 `--` 之后。需要管道、重定向时用 `-- sh -c '…'`。

退出码：`0` 成功、`1` 失败、`124` 超时、`42` 输出空闲（卡死）、`43` 命中致命输出、`2` 参数错误。

## 在 DSH 里怎么用

长任务用 bash 工具的后台模式启动，再用 `job_output` 等待，不要在前台干等：

```
bash: node ~/.dsh/skills/task-watchdog/scripts/watchdog.mjs --idle 120 -- pnpm build
      (run_in_background: true)
然后 job_output(job_id, wait: true) 收结果
```

- 看门狗自己负责卡死/超时止损；DSH 的 `job_output` 负责等待与取输出，两者不冲突。
- 已有明确 timeout 的短命令（几秒内结束）不要套它，调度开销和通知噪音不值得。
- 需要交互输入的命令不要用（stdin 是关闭的）。

## 读报告，然后怎么办

stdout 末尾是一行人类摘要加一份 JSON；完整报告写在 `--log-dir` 下的 `*.report.json`，含 `status`、`durationMs`、`exitCode`/`signal`、`reason`、`logFile`、最后 20 行 `tail`。

| status | 处置 |
|---|---|
| `success` | 继续下一步 |
| `failed` | 读 `tail` 定位退出原因；是代码/依赖问题就修，不要原样重跑 |
| `stalled` | `--idle` 可能设得比该命令的正常静默期短；先看日志判断真卡还是误报，再调阈值重试 |
| `timeout` | 拆小任务，或确认上限后调 `--timeout`；不要无限重试 |
| `fatal` | 命中 `--fail-on` 的关键错误，按错误本身处理，别绕开 |

触发后进程组已被 SIGTERM/SIGKILL 收敛；若任务留下锁文件、临时目录或半成品，做一次有界清理，并把「做到哪、还差什么」写进交接说明再重试。

## 边界

- 判定依据是**输出空闲**：编译、下载等长时间无输出的阶段会被误判，按该命令的正常静默期设 `--idle`。
- 只监督启动的命令及其进程组；通过 SSH、容器、系统服务派生的进程不在此范围，需在远端各自守护。
- 报告与日志默认在临时目录，系统清理临时文件后不保留；需要留存时用 `--log-dir` 指到项目目录。
