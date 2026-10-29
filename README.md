# AgentManager

一个只在本机运行的网页，统一管理 Claude Code、Codex、pi 三个 code agent 的 **skills、全局提示词与配置**。

做的事情：

- **skills 矩阵** — 一屏看清每个 skill 在哪个 agent 里生效、哪些是副本、哪些链接已经断了，并能建链、把孤儿副本收进源、移除多余副本。
- **提示词单一源** — `~/.agents/prompts/global.md` 是唯一正文，`CLAUDE.md` / `AGENTS.md` 通过硬链接指向它，改一处全部生效。
- **settings 可编辑** — 按 Claude Code / Codex / pi 的官方 schema 渲染分组表单，文件里没有的设置项也能填（留空即不写入）；MCP server 有结构化编辑器，每个文件还有原始 JSON/TOML 编辑器；写入前自动快照，外部改动用 etag 检测冲突。
- **模型从本地端点读取** — 默认请求 `http://127.0.0.1:15721/v1/models`，在「模型」页签里为三个 agent 分别选择模型；模型字段也带候选列表，支持手动输入。来源可用 `AGENT_MANAGER_MODELS_URL` 覆盖。
- **MCP 单一源** — `~/.agents/mcp/servers.json` 是唯一源，矩阵按 agent 显示 已同步 / 有差异 / 缺失 / 孤儿 / 无效 / 不支持，支持收进源、同步到全部或单个 agent、从源删除或从 agent 移除。
- **写前自动快照** — 每次改文件前先备份，页面上可回滚到任意一次操作；还原本身也会先建安全快照，误还原可再撤销。

### 设置页怎么用

- 选择 agent 后按「模型 / 常用 / 分组 / MCP servers / 原始文件」切换；字段说明来自官方 schema（中文），文件里没有的键也会显示，填了才写入，清空即删除。
- 「模型」页签从本地 OpenAI 兼容端点读取模型清单，为 Claude Code（`env.ANTHROPIC_MODEL` 或 `model`）、Codex（`model`）、pi（`defaultModel`）分别选择；选择后点底部「保存全部」。
- 「MCP」页签以 `~/.agents/mcp/servers.json` 为源：先把现有 agent 里的 server 收进源，再同步到全部 agent；同名定义不一致会标为「有差异」，可同步或以某一格为准更新源。写入前自动快照。
- MCP server 用结构化表单增删改；Claude 写入 `~/.claude.json` 的 `mcpServers`，Codex 写入 `config.toml`，pi 写入 `mcp.json`。
- 每个文件都有原始 JSON/TOML 编辑器；保存前自动快照，外部改动会触发 409 冲突提示。
- 密钥默认打码，点「显示」才明文；原始编辑器默认显示遮罩预览。
- 「仅托管生效」的键和会执行命令的字段（hooks、statusLine 等）会在保存前二次确认。

## 运行

### 独立程序（推荐）

```bash
npm install
npm run build:exe         # 产物 release/AgentManager.exe：内嵌前端 + Node SEA，不依赖本机 node
npm run verify:exe        # 起真实 exe 验证启动、内嵌 UI、--status 与退出
npm run install:shortcut  # 桌面 + 开始菜单快捷方式（经 wscript 启动，不弹控制台）
```

双击 `release/AgentManager.exe`（或快捷方式）会启动本地服务并打开一个无地址栏的应用窗口；exe 采用 GUI 子系统，双击不会再弹出控制台窗口。已经运行时再点只会再开一个窗口。命令行参数：

```bash
AgentManager.exe              # 启动服务并打开窗口
AgentManager.exe --no-window  # 只起服务
AgentManager.exe --status     # 查看是否在运行
AgentManager.exe --stop       # 停止
AgentManager.exe --port 7788  # 指定端口（占用时顺延）
AgentManager.exe --data <dir> # 指定运行时数据目录
AgentManager.exe --version    # 打印版本
```

运行数据（`runtime.json`、`runtime.lock`、`app.log`、`snapshots/`）默认放在 exe 同级的 `data/`；该目录不可写时回退到 `%LOCALAPPDATA%\AgentManager`（POSIX 为 `~/.local/state/agent-manager`）。`npm run install:autostart` 可加入开机启动，`npm run uninstall:shortcut` 移除。

### 源码模式

```bash
npm run dev     # API 127.0.0.1:7788 + 浏览器界面 http://localhost:5173
```

生产模式（单进程，同时服务页面与 API）：

```bash
npm run build
npm start       # 启动服务并打开应用窗口（127.0.0.1:7788）
```

其他命令：

```bash
npm test        # node:test，含一套起真实服务的端到端用例
npm run typecheck
npm run check   # 两者一起跑
```

## 目录

```
server/     扫描、写操作、提示词、配置、设置读写、快照、启动器，以及 HTTP 路由
web/        React 单页（左侧导航 + skills / 提示词 / 设置三个视图）
shared/     服务端与前端共用的 API 契约
schemas/    Claude Code / Codex / pi 的官方配置 schema（settings catalog 的来源）
scripts/    独立 exe 构建/验证、schema catalog 生成与 Windows 快捷方式安装
release/    独立程序产物（git 忽略）
data/       快照与运行状态（git 忽略）
```

约定与决策记录在 `goal-and-requirements.md`、`architecture.md`、`server/SPEC*.md`。

## 边界

只管用户级全局配置，不碰仓库内的项目级配置；settings / MCP 只读；只对接 Claude Code、Codex、pi；单机单用户，监听 `127.0.0.1`。
