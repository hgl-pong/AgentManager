---
id: agent-manager
type: goal-and-requirements
title: "AgentManager — 多 code agent 配置管理器"
status: active
tags:
  - personal-tool
  - agent-config
---

# AgentManager

一个只在本机运行的网页，把多个 code agent 的 skills、全局提示词与配置收敛成「一份源 + 各 agent 处链接」。

## Overview

AgentManager 是给自己用的本地配置管理器：启动一个本地服务，在浏览器里横向看到 Claude Code、Codex、pi 三个 agent 的 skills、全局提示词和 settings / MCP 配置，并把它们统一到单一源。它替换掉现在手工建 Windows junction、手工复制 skill 目录、以及同时维护 `CLAUDE.md` 和 `AGENTS.md` 的做法。

## Problem

我日常在 Claude Code、Codex、pi 之间切换，每个 agent 有自己的全局目录和配置格式，维护全靠手工：

- **skills**：`~/.agents/skills` 里的 6 个 skill 只被链进了 `~/.claude/skills`（Windows junction）；`~/.codex/skills` 是另外 13 个 skill，与源零交集；`~/.pi/agent/skills` 下只有一个 `vision-support`，而它是指向不存在目标的悬空 junction。某个 skill 到底在哪个 agent 里生效、哪些链接已经断了，只能逐目录 `ls` 猜，而且不开就不看出来。
- **全局提示词**：`~/.claude/CLAUDE.md`（2433 字节）与 `~/.codex/AGENTS.md`（2398 字节）内容近乎相同却各自演化。改一条规则要改两处，漏一处就出现跨 agent 行为不一致。
- **配置**：`settings.json` / `config.toml` / `mcps.json` 分散在三个目录，没有一处能看出同一个 MCP server 在哪几个 agent 里配过。

结果：漂移是默认状态，只有在某个 agent 行为不对时才会被发现。新增一个 skill 要在每个 agent 目录里手工重建一遍，漏做不会有任何提示。

## Capabilities

模型统一为「源 → agent」：内容只在一个位置存在，其余 agent 处只放指向它的链接。

1. **现状总览** — 一屏列出三个 agent 的 skills 数量与状态（已链接 / 副本 / 孤儿 / 缺失 / 链接失效 / 外部链接）、提示词是否同一份、settings 与 MCP 清单。只有含 `SKILL.md` 的目录算一个 skill，容器目录（如 Codex 的 `.system`）不计。
2. **skills 对齐** — 以 `~/.agents/skills` 为源，对每个 agent 目录逐 skill 显示上述状态；支持为其建链、把孤儿副本导入源、删除多余副本（删除前进入快照）。首次运行只扫描并接管现有链接，不批量改动。
3. **全局提示词单一源** — 新建 `~/.agents/prompts/global.md` 作为唯一正文，`CLAUDE.md` 与 `AGENTS.md` 改为指向它的链接；在界面里编辑源即刻对所有 agent 生效。首次迁移以内容更全的 `CLAUDE.md` 为准，原两份文件先备份。
4. **settings / MCP 只读对比** — 展示三个 agent 的配置文件位置、MCP server 清单与逐字段差异，提供一键用系统默认编辑器打开。只读，不写回。
5. **写前自动快照** — 任何写操作（建链、删副本、改提示词）前先保存受影响文件或目录，界面可回滚到任一快照。第 2、3 项都是批量改链接，这是兜底。

## Non-Goals

- 不管项目级配置：仓库内的 `.claude/`、`AGENTS.md`、`.agents/skills` 不在范围内（已决定只处理用户级全局配置）。
- 不在界面内写回 settings / MCP 配置，修改交给外部编辑器。
- 不服务 Claude Code、Codex、pi 之外的 agent（Gemini CLI、Copilot CLI、Kimi Code、CodeMaker 明确不做）。
- 不做多用户、安装包、跨机器同步或云备份：单机、单用户、`127.0.0.1`。
- 不代跑 agent：不启动会话、不代理模型请求。

## Tech Notes

| 方面 | 选择 | 理由 |
| --- | --- | --- |
| 语言 | Node.js + TypeScript | 配置全是 JSON / TOML，Node 解析生态成熟，本机已有 node |
| 形态 | 本地 HTTP 服务 + 浏览器界面 | 单用户单机，无需打包分发 |
| 目录链接 | Windows junction（`mklink /J`） | 目录链接不需要管理员权限，与现有 `~/.claude/skills` 的做法一致 |
| 提示词文件链接 | 源文件 + 各 agent 处文件链接；symlink 不可用时回退硬链接，再退化为副本并在界面标注「非链接」 | **未确认**：需首次运行实测三个 agent 是否都跟随链接读取（symlink 在 Windows 需要开发者模式或管理员权限，硬链接要求同盘） |
| 配置解析 | JSON / TOML，只读 | 只做对比，无写回路径 |
| 快照 | 写前复制到本地快照目录 | 不依赖 git，回滚只需还原文件 |
| 状态来源 | 每次加载直接扫描文件系统，不建索引库 | 配置会被手工或 agent 自身改动，缓存必然过期 |

## Alternatives Considered

**决定：先安装 skillshare 实际跑一轮（把现有手工 junction 迁过去），确认它在源目录布局与提示词合流上是否够用；不够用才按本文档实施。** 下面留档，免得以后重写时又漏掉现成方案。

| 方案 | 与本文档的差距 | 链接 |
| --- | --- | --- |
| skillshare | 范围最接近且更宽（skills / agents / rules / MCP / hooks，含 Pi 与 Windows 桌面端），差距是默认源目录为 `~/.config/skillshare/skills`（Windows `%AppData%\skillshare`），与现有 `~/.agents/skills` 不同，需要迁移或改配置 | https://github.com/runkids/skillshare |
| hana | CLI，以「单一源 + 同步」为中心统一 skills 与 instructions，支持 Claude Code / Codex / Pi / OpenCode；不提供本方案要的本机链接状态总览 | https://github.com/qodot/hana |
| sk (skills-supply) | 用 `agents.toml` 一份清单把 skill 分发到多 agent，偏 skill 包管理与市场分发，不做跨 agent 配置对比 | https://github.com/803/skills-supply |
| claude-config-manager | Node 本地 UI，能编辑 Claude Code 的全部配置文件；只服务单一 agent，不跨 agent | https://github.com/HarshitSingh-PM/claude-config-manager |
| Saddle | 定位是「一次配置、多机多工具同步」；本方案要的是本机单源 + 每个链接状态的可见性 | https://saddle.sh/ |
