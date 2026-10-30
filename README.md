# DSH 全局技能：claw-doing + task-watchdog

仓库：<https://github.com/CX124586/dsh-global-skills>

两个技能装在 **用户级技能目录**（`~/.dsh/skills`），DSH 的任何项目会话都会自动加载，不需要在每个项目里重复配置。

```sh
# 换一台机器：克隆后一键安装
git clone git@github.com:CX124586/dsh-global-skills.git
cd dsh-global-skills && node install.mjs
```

| 技能 | 解决什么 | 入口脚本 |
|---|---|---|
| `claw-doing` | 跨项目看 DSH agent 此刻在干什么：正在跑的工具、未结束的后台任务、卡了多久 | `~/.dsh/skills/claw-doing/scripts/doing.mjs` |
| `task-watchdog` | 长任务看门狗：输出空闲 / 超时 / 致命输出触发通知、有界清理、给结构化报告 | `~/.dsh/skills/task-watchdog/scripts/watchdog.mjs` |

## 安装

```sh
node install.mjs              # 安装或更新（覆盖前自动备份为 <技能名>.bak-<时间戳>）
node install.mjs --dry-run    # 只看会做什么
node install.mjs --uninstall  # 卸载
```

装完新开一个 DSH 会话生效；已开着的会话要重开任务才会重新加载技能目录。

## 来历

两者都改编自 OpenClaw 生态的现成项目，接口按 DSH 的实际情况重写（DSH 没有 OpenClaw 的运行时插件 API，所以落成「技能 + 零依赖脚本」）：

- `claw-doing` ← [seekcontext/claw-doing](https://github.com/seekcontext/claw-doing)（OpenClaw 运行/调试查看器）。原版读 OpenClaw 的 SQLite 运行库并带 Ink TUI；DSH 版改为只读解析 DSH 自己的会话日志（`~/.dsh/sessions/**/session.v*.jsonl.zstd`），不需要数据库和界面依赖。
- `task-watchdog` ← ClawHub 技能 [anotherj1/task-watchdog](https://clawhub.ai/anotherj1/skills/task-watchdog)（挂机任务守护：定时检查进度、关弹窗、致命错误报警）。原版依赖 OpenClaw 的屏幕控制；DSH 版改为命令行进程守护，用输出空闲/总时长/致命输出三类信号判定，并把「关弹窗」换成「按进程组有界清理」。

上游源码见 <https://github.com/seekcontext/claw-doing>，便于对照；本机另存了一份克隆在 `../.claw-upstream/claw-doing`（不在本仓库内）。

## 快速验证

```sh
node ~/.dsh/skills/claw-doing/scripts/doing.mjs --limit 3
node ~/.dsh/skills/task-watchdog/scripts/watchdog.mjs --no-notify --idle 2 -- sh -c 'sleep 10'
echo "退出码应为 42：$?"
```
