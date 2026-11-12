# AgentManager

一个只在本机运行的网页，统一管理 Claude Code、Codex、pi 三个 code agent 的 **skills、全局提示词与配置**。

做的事情：

- **skills 矩阵** — 一屏看清每个 skill 在哪个 agent 里生效、哪些是副本、哪些链接已经断了，并能建链、把孤儿副本收进源、移除多余副本，或从源里删除 skill（同时移除指向它的链接；独立副本和外部链接保留，删除前自动快照）。
- **提示词单一源** — `~/.agents/prompts/global.md` 是唯一正文，`CLAUDE.md` / `AGENTS.md` 通过硬链接指向它，改一处全部生效。
- **settings 可编辑** — 按 Claude Code / Codex / pi 的官方 schema 渲染分组表单，文件里没有的设置项也能填（留空即不写入）；MCP server 有结构化编辑器，每个文件还有原始 JSON/TOML 编辑器；写入前自动快照，外部改动用 etag 检测冲突。
- **模型 provider** — 保存多个 OpenAI 兼容 provider（只需 base URL 与 API key），选一个 active；Provider 页读取并展示它的模型，设置页的 model 字段直接使用 active provider 的候选。API key 只保存在本机、只在服务端请求时使用，GET 接口不会返回。
- **MCP 单一源** — `~/.agents/mcp/servers.json` 是唯一源，矩阵按 agent 显示 已同步 / 有差异 / 缺失 / 孤儿 / 无效 / 不支持，支持收进源、同步到全部或单个 agent、从源删除或从 agent 移除。
- **Hooks 单一源** — `~/.agents/hooks/hooks.json` 以事件为单位保存 Claude Code / Codex 的 hooks，矩阵显示 已同步 / 有差异 / 缺失 / 孤儿 / 不支持 / 不适用，可导入、同步、移除；pi 没有原生 hooks。
- **缓存清理** — 按白名单列出三个 agent 的会话记录与缓存（`~/.claude/projects`、`~/.codex/sessions` / `.tmp`、`~/.pi/agent/sessions` 等）各占多少、多老，可按 1/7/30/90 天或整体清理；清理只是移到回收站（同一卷上是 `rename`，不复制内容），可原样恢复，只有「清空回收站」才真正释放磁盘。
- **写前自动快照** — 每次改文件前先备份，页面上可回滚到任意一次操作；还原本身也会先建安全快照，误还原可再撤销。

- **商店** — 一个页面两个目录：skill 来自 [skillstore.io](https://skillstore.io)，MCP server 来自官方 [MCP Registry](https://registry.modelcontextprotocol.io)。搜索或浏览后一键把 skill 装进 `~/.agents/skills` 并建链，或把 MCP server 写进 `~/.agents/mcp/servers.json` 并同步到勾选的 agent。页面文案支持中文 / English / 双语；skill 安装前校验 manifest 的 sha256，包里没有 `SKILL.md`、校验不符或同名已存在都不动磁盘；MCP 安装前在弹窗里填写注册表要求的 API key 等必填项。Skills 第一页顶部另有「内置技能」栏：随应用分发的 skill（目前是 skillify 与 cpp-windows-debug，前者把一次会话整理成可复用的 `SKILL.md`，后者覆盖 Windows C++ 的构建与调试）无需联网，预览与安装都走本地内容，写入前同样建快照。

### Provider 页怎么用

- 左侧列表保存多个 provider；每个只需要 base URL 与 API key，不要求额外名称，显示名自动取 base URL 的 host。
- 点一个 provider 会把它设为 active；右侧表单可以改 base URL / API key。编辑时 API key 留空表示保留原 key，页面上不会回显已保存的 key。
- 保存后请求 `<base URL>/models` 读取模型，展示 ID / 名称、分组、上下文、输出、推理强度与 thinking / 图片 / PDF 能力；可筛选、刷新，失败会显示错误或上次的缓存。
- active provider 的模型会直接成为设置页 agent `model` 字段的候选；原本设置页的「模型」页签已移除。
- Provider 文件是 `~/.agents/providers.json`，API key 以明文保存在本机（尽量 0600），GET `/api/providers` 只返回 `hasApiKey`，不返回 key；每次写入前自动建快照。
- 删除 active provider 后会自动切到列表里的下一个；删完则回到空白，设置页模型候选为空，仍可手动输入模型 ID。

### 商店页怎么用

- 左侧「目录」栏切 `Skills` / `MCP`。Skills 的源是 [skillstore.io](https://skillstore.io)：搜索框留空时列出它的目录（每行带分类、风险级别、许可证与质量分），输入关键词回车即搜；同名技能会排在前面。
- `Skills` 第一页顶部是「内置技能」栏：原文打包在应用里（目前是 skillify 与 cpp-windows-debug，均为 MIT），预览不请求注册表；安装把文件复制进 `~/.agents/skills/<name>` 再按勾选建链，弹窗里写明目的地与目标 agent。搜索时按名称 / 摘要 / 能力在本地匹配，第 2 页起不再重复出现。
- 点卡片本身（不是「安装」）先打开预览：skill 会即时读取完整记录——完整描述、能力 / 限制 / 使用场景、文件结构、安全审查摘要、风险因素、仓库与下载收藏数；MCP server 列出全部安装方式、每个方式要填的变量以及仓库 / 官网。预览底部也能直接安装，键盘 `Enter` / 空格同样能打开。
- Skills 一页 24 个，底部「上一页 / 下一页」带「第 N / M 页」（M 是注册表给出的总页数，热门目录 280 页左右）；换页会自动滚回列表顶部，换关键词或点「热门」会回到第 1 页。
- MCP 的源是官方 Registry：它只按名称搜索且至少 3 个字符，没有总数、按游标翻页，所以底部只显示「第 N 页」。卡片上是 server 的反向域名名、标题、描述与可用的传输方式。
- 左侧「语言」栏的「中文 / English / 双语」切换整个商店页的文案（默认中文，选择记在本地）；skill 与 MCP server 自己的名字、描述、许可证是发布者写什么就是什么，不做机器翻译。
- 左侧「安装后链接到 / 同步到」勾选目标 agent（默认跟随已检测到的 agent）。Skills 卡片上的「安装」先弹确认框，写明要下的 `owner/slug`、落地的绝对路径、会建哪些链接，以及发布者 / 风险 / 质量；带脚本的 skill 会单独提醒。
- MCP 卡片上的「安装」打开安装弹窗：可选 `npm` / `pypi` / `oci` 包或 `http` / `sse` 远端地址，改名后写入源；注册表标为必填且没有默认值的 env / header / URL 变量在这里填写（密钥用密码框），`Bearer {token}` 这类值里的占位符同样逐个列出、安装时替换，默认值已自动带好。sse 会提示 Codex 与 pi 不支持。
- Skills 安装分两步：先读 `…/manifest` 拿到下载地址和 sha256，再下 ZIP 到 `data/tmp/` 校验（校验值、ZIP 头、必须有 `SKILL.md`、路径不许越界），最后整体 `move` 进源目录；任何一步失败都不会在源里留下半个 skill。
- MCP 安装写进源后，逐个 agent 文件各建一份快照再同步；提示里的快照 id 可在快照面板整体撤销。
- 「源里已有」表示源目录（或 MCP 源）里已经有同名条目；skill 到 Skills 页对应行点「删除」，MCP 到 MCP 页从源移除，或先改名再装。
- 两个注册表默认 `https://skillstore.io` 与 `https://registry.modelcontextprotocol.io`，可分别用 `AGENT_MANAGER_STORE_URL` / `AGENT_MANAGER_MCP_STORE_URL` 指向实现同一接口的镜像；注册表挂了会显示上次的缓存并标注抓取时间。
- 下载的临时目录默认 `data/tmp/`（`AGENT_MANAGER_STORE_TEMP` 可改），安装成功或失败都会清空。

### 设置页怎么用

- 选择 agent 后，页签下方显示该 agent 的配置文件条（文件角色、路径与字节数）；左侧索引按「常用 / 分组 / MCP servers / 原始文件」切换。设置页不再有独立的「模型」页签，模型字段与其他字段一样编辑。字段说明来自官方 schema（中文），文件里没有的键也会显示，填了才写入，清空即删除。
- 模型字段（Claude Code 的 `model` / `env.ANTHROPIC_MODEL`、Codex 的 `model`、pi 的 `defaultModel` 等）从 active provider 的模型清单取候选；也可以直接输入自定义 ID。选完点底部「保存全部」。
- 「MCP」页签以 `~/.agents/mcp/servers.json` 为源：先把现有 agent 里的 server 收进源，再同步到全部 agent；同名定义不一致会标为「有差异」，可同步或以某一格为准更新源。写入前自动快照。
- 「Hooks」页签以 `~/.agents/hooks/hooks.json` 为源，按事件分别保存 Claude/Codex 的 matcher 组与 handler；Codex 修改后需要在 Codex 里用 `/hooks` 重新信任。
- MCP server 用结构化表单增删改；Claude 写入 `~/.claude.json` 的 `mcpServers`，Codex 写入 `config.toml`，pi 写入 `mcp.json`。
- 每个文件都有原始 JSON/TOML 编辑器；保存前自动快照，外部改动会触发 409 冲突提示。
- 密钥默认打码，点「显示」才明文；原始编辑器默认显示遮罩预览。
- 「仅托管生效」的键和会执行命令的字段（hooks、statusLine 等）会在保存前二次确认。
- 提示词保存带乐观锁：文件被其它程序改过时保存会被拒绝，编辑器保留草稿并提供「载入磁盘版本」，不会静默覆盖。
- 所有写操作都用同一个模态确认框：文案写明会改动的具体路径，删除类操作默认聚焦「取消」，`Esc` 取消；写入失败时错误显示在同一个弹框里，可直接重试。
- `Ctrl+S` 保存：设置页保存全部改动，提示词页保存单一源；确认框打开时两个快捷键都不响应。
- 模型字段用可搜索的选择器（↑/↓ + Enter 选、Esc 关），支持输入自定义 ID 或清空回退到 agent 默认值。

### 缓存页怎么用

- 表格按 agent 分组（Claude Code / Codex / pi 各有自己的颜色块），每组表头就是该 agent 的合计与「清理本组」；只列出真的有内容的位置，空目录不会摆在表里。
- 顶部「清理范围」默认「全部文件」；选 1 / 7 / 30 / 90 天时表格会多出一列「N 天前」，行里的「清理」就只移动那一部分。每次清理都会先弹确认框写明具体路径、文件数与体积。
- 清理是**移动**：内容进入 `data/recycle/`（可用 `AGENT_MANAGER_CACHE_RECYCLE` 改位置），行里的数字立刻下降，但内容还在；「回收站」面板里可一键恢复，原位置已被 agent 重新写入的文件不会被覆盖。
- 只有「清空回收站」是永久删除；它先弹一个默认聚焦「取消」的确认框。
- 标「含对话」的是会话记录与提示词历史（删了就没法 `--resume` 回看），标「可重建」的是缓存、日志、shell 快照与 `*.bak-*` 备份；配置文件（`settings.json`、`config.toml`、`AGENTS.md` 等）不在任何清理目标里。

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

运行数据（`runtime.json`、`runtime.lock`、`app.log`、`snapshots/`、`recycle/`）默认放在 exe 同级的 `data/`；该目录不可写时回退到 `%LOCALAPPDATA%\AgentManager`（POSIX 为 `~/.local/state/agent-manager`）。`npm run install:autostart` 可加入开机启动，`npm run uninstall:shortcut` 移除。

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
npm run verify:ui  # 先用 npm run build 构建；用无头 Edge/Chrome 跑交互检查（确认弹框、Ctrl+S、模型选择器等）
npm run shots      # 同上构建后，把每页明暗两套、商店预览与 390px 手机视图截图写到 .build/shots/，用于肉眼核对样式
```

## 目录

```
server/     扫描、写操作、提示词、配置、设置读写、商店（skill 与 MCP）、缓存与回收站、快照、启动器，以及 HTTP 路由
web/        React 单页（分组侧栏 + Skills / 商店 / 提示词 / MCP / Hooks / 缓存 / 设置）
shared/     服务端与前端共用的 API 契约
schemas/    Claude Code / Codex / pi 的官方配置 schema（settings catalog 的来源）
scripts/    独立 exe 构建/验证、schema catalog 生成与 Windows 快捷方式安装
release/    独立程序产物（git 忽略）
data/       快照、回收站与运行状态（git 忽略）
```

约定与决策记录在 `goal-and-requirements.md`、`architecture.md`、`server/SPEC*.md`；界面功能清单与重设计说明在 `docs/ui-redesign-brief.md`；视觉方向与色板/字体/几何约定在 `DESIGN.md`。

## 边界

只管用户级全局配置，不碰仓库内的项目级配置；缓存页只处理白名单里的会话记录与缓存，配置文件永不进入清理范围；商店只往源目录装文件，不执行 skill 内容、不启动 MCP server、不做升级与发布；只对接 Claude Code、Codex、pi；单机单用户，监听 `127.0.0.1`。
