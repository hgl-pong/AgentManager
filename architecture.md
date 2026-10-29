---
id: architecture
type: architecture-design
status: active
title: AgentManager 架构
parent: agent-manager
---

## Drivers

- 配置的真相始终在磁盘上：agent 自己也会改文件，任何索引或缓存都会过期。
- 单机、单用户，不需要账号、分发或远程访问。
- 写操作必须可回滚：改的是 `~/.claude`、`~/.codex`、`~/.pi` 里的真实文件。

## Decisions

```
浏览器 ──dev──▶ Vite 5173 ──/api 代理──▶ Node API 7788 ──▶ server/*.ts ──▶ 文件系统
浏览器 ──start─▶ Node API 7788（同时直接服务 dist/）
```

- **后端跑源码**：Node 24 原生剥离类型，`node server/index.ts` 直接运行 `.ts`，不引入构建步骤或 tsx。`tsc --noEmit` 只用于类型检查。
- **契约共享**：`shared/types.ts` 同时被 `server/` 与 `web/` 导入，API 形状只定义一次，且不含 `node:` 导入。
- **每次请求实时扫描**：`GET /api/matrix` 每次重新读目录、重算哈希。实测 477 个文件 / 8MB 约 15ms，缓存只会带来过期状态。
- **链接是首选共享方式**：skill 目录用 Windows junction（`fs.symlinkSync(..., 'junction')`，不需管理员权限），提示词文件用硬链接（编辑任一端都改到同一份内容）。扫描的主轴因此是「链接 / 实体」，不是文件内容。
- **写路径先快照**：三个 skills 动作与两个提示词动作都先调用 `createSnapshot`，把受影响路径和将要新建的路径登记下来，失败也能还原。
- **settings / MCP 只读**：可以对比、可以交给编辑器打开，但任何代码路径都不写配置文件。
- **前端用 Vite + React**：后续交互都带确认与回滚状态，比起服务端直出少一次重写。
- **Vite 锁在 7.x**：Vite 8（rolldown）无法解析 `react-dom/client` 里的相对 CJS 引用，构建失败；7.x 构建正常。

## Invariants

- 扫描不写任何文件；页面上的数字必须能在磁盘上复现。
- 每个写操作都对应一条快照，快照里能还原到操作前的状态。
- 配置文件永不写入；`POST /api/open` 只接受已知配置路径的白名单。
- API 只监听 `127.0.0.1`，请求体上限 1MB。
- 新增 agent 只需在 `server/index.ts` 的清单里加一条 `{key, label, root}`，扫描逻辑不动。
- 前端不自己推导状态：格子显示的是后端给出的 `state`。

## Out of scope

- 项目级目录扫描（仓库内的 `.claude/`、`AGENTS.md`）。
- 多用户、远程访问、安装包、云端备份。
- 快照的自动清理与保留策略。
