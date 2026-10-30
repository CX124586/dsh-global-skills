---
name: claw-doing
description: 查看 DSH agent 此刻在干什么——跨项目列出最近会话的实时状态：正在执行哪个工具、有哪些未结束的后台任务、最后活动距今多久、哪些会话疑似卡住。只读解析 ~/.dsh 会话日志，不需要 DSH 运行时或网络。用当用户问「现在在跑什么 / 哪个任务卡住了 / 进度怎么样 / 别的项目那个会话在干嘛」，或需要多项目总览时。
---

# claw-doing · 此刻 agent 在干什么

把 DSH 最近若干会话的实时状态拉成一张总览：谁在跑、跑到哪一步、在等什么、卡了多久。
脚本零依赖、只读，不打扰正在运行的会话。

## 用法

脚本随技能全局安装，任何 DSH 项目里直接调用：

```sh
node ~/.dsh/skills/claw-doing/scripts/doing.mjs                  # 最近 10 个会话总览
node ~/.dsh/skills/claw-doing/scripts/doing.mjs --watch 3         # 每 3 秒刷新，Ctrl-C 退出
node ~/.dsh/skills/claw-doing/scripts/doing.mjs --json            # 机器可读，供后续处理
node ~/.dsh/skills/claw-doing/scripts/doing.mjs --session a4afdf62 --events 20   # 单会话明细
```

参数：

| 参数 | 默认 | 含义 |
|---|---|---|
| `--all` | 关 | 包含 12 小时以前没有活动的会话 |
| `--limit N` | 10 | 最多显示 N 个会话 |
| `--idle N` | 120 | 最后活动不足 N 秒算「运行中」 |
| `--stall N` | 300 | 工具运行超过 N 秒且会话已无新事件时标「可疑卡住」 |
| `--watch [N]` | 3 | 每 N 秒刷新一次 |
| `--session <id>` | — | 只看某个会话的最近事件（id 前缀即可） |
| `--events N` | 15 | 明细模式显示 N 条事件 |
| `--json` | 关 | 输出 JSON |

## 读输出

```
claw-doing · 11:19:06 · 5 个最近会话
运行中 1 · 可疑卡住 2 · 空闲 2

● 运行中 · 0s前 · a4afdf62 · turn 1 step 49
  ~/Deepseek-Harness/网页开发3-DSH使用说明
  工具 bash · cd ~/… && node -e "…" · 已运行 0s
```

| 状态 | 含义 | 该做什么 |
|---|---|---|
| ● 运行中 | 30 秒内有新事件 | 正常，等它继续 |
| ▲ 可疑卡住 | 有工具调用迟迟没有结果 | 看明细判断：长构建属正常；`present`/`ask` 类工具多半在等人确认 |
| ○ 空闲 | 最后事件已超 `--idle` | 会话没在动 |

明细里的活动类型：`工具 X · 已运行 Ns`、`后台任务 <kind> 运行 Ns`、`模型思考中`、`等待模型`、`生成会话标题` 等。

## 数据来源与边界

- 只读 `$DSH_HOME/sessions/<项目>/<会话>/session.v*.jsonl.zstd`（默认 `~/.dsh/sessions`），每个会话只解码最近 400 个 zstd 帧。
- 依赖会话日志格式 v4 的字段（`type`/`time`/`tool/call`/`tool/result`/`job/registered`/`job/settled`）。DSH 升级后若字段变化，先跑一次总览确认，再按需改脚本。
- 它观察的是**落盘的事件**：模型正在生成回复时事件可能还没写盘，因此「0s 前」不等于逐 token 实时。
- 结束进程或关掉 App 的会话会留下未返回的工具调用，显示为「可疑卡住 + 上次调用未返回」，不是故障。
