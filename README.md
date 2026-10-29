# AgentManager

一个只在本机运行的网页，统一管理 Claude Code、Codex、pi 三个 code agent 的 **skills、全局提示词与配置**。

做的事情：

- **skills 矩阵** — 一屏看清每个 skill 在哪个 agent 里生效、哪些是副本、哪些链接已经断了，并能建链、把孤儿副本收进源、移除多余副本。
- **提示词单一源** — `~/.agents/prompts/global.md` 是唯一正文，`CLAUDE.md` / `AGENTS.md` 通过硬链接指向它，改一处全部生效。
- **settings / MCP 只读对比** — 列出三个 agent 的 MCP server 分布与配置键摘要（密钥打码），一键交给编辑器。
- **写前自动快照** — 每次改文件前先备份，页面上可回滚到任意一次操作。

## 运行

```bash
npm install
npm run dev     # API 127.0.0.1:7788 + 浏览器界面 http://localhost:5173
```

生产模式（单进程，同时服务页面与 API）：

```bash
npm run build
npm start       # http://127.0.0.1:7788
```

其他命令：

```bash
npm test        # node:test，含一套起真实服务的端到端用例
npm run typecheck
```

## 目录

```
server/     扫描、写操作、提示词、配置、快照，以及 HTTP 路由
web/        Vite + React 单页（skills / 提示词 / settings 三个视图）
shared/     服务端与前端共用的 API 契约
data/       快照存放处（git 忽略）
```

约定与决策记录在 `goal-and-requirements.md`、`architecture.md`、`server/SPEC*.md`。

## 边界

只管用户级全局配置，不碰仓库内的项目级配置；settings / MCP 只读；只对接 Claude Code、Codex、pi；单机单用户，监听 `127.0.0.1`。
