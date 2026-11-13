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
应用窗口（Edge/Chrome --app）──▶ AgentManager.exe ──▶ 内嵌 dist/ + Node SEA
                                      │
                                      ├─ 单实例：data/runtime.json + /api/health
                                      └─ HTTP API 7788 ──▶ server/*.ts ──▶ 文件系统

浏览器 ──dev──▶ Vite 5173 ──/api 代理──▶ Node API 7788 ──▶ server/*.ts ──▶ 文件系统
浏览器 ──start─▶ Node API 7788（同时直接服务 dist/）
```

- **独立程序用 Node SEA 打包**：`scripts/build-exe.mjs` 用 esbuild 把服务端打成 CJS，把 `dist/` 以 base64 注入 `virtual:assets`，再生成 SEA blob 注入 `node.exe`。产物先写到 `.build/release-next`，成功后才替换 `release/` 里的 exe 与 vbs，`release/data` 与其它文件不被构建清理。目标机不需要安装 Node，前端也不依赖同目录的 `dist/`。
- **窗口是应用窗口，不是浏览器标签**：启动器用 Edge/Chrome 的 `--app=<url>` 打开，找不到浏览器再退回系统默认浏览器。exe 构建完成后把 PE 子系统从 console 改成 GUI，双击不再分配控制台窗口；启动失败时 exe 用系统消息框提示并写 `app.log`。`AgentManager.vbs`/快捷方式仍保留，用于显式隐藏启动。
- **单实例**：数据目录里的 `runtime.lock` 独占锁 + `runtime.json` 记录 pid/port/url。再次启动先等锁、再做多次健康检查，命中后只在 `health.dataDir` 与当前目录一致时复用；`--status` / `--stop` 走同一份状态，不同数据目录互不干扰。默认 `data/` 不可写时回退到用户状态目录（`%LOCALAPPDATA%\AgentManager`）。
- **本地写接口的来源校验**：所有 `POST /api/*` 校验 Host、Origin 与 `Content-Type: application/json`，避免任意网页用简单请求改写配置或关闭程序。
- **后端跑源码**：Node 24 原生剥离类型，`node server/index.ts` 直接运行 `.ts`，不引入构建步骤或 tsx。`tsc --noEmit` 只用于类型检查。
- **契约共享**：`shared/types.ts` 同时被 `server/` 与 `web/` 导入，API 形状只定义一次，且不含 `node:` 导入。
- **每次请求实时扫描**：`GET /api/matrix` 每次重新读目录、重算哈希。实测 477 个文件 / 8MB 约 15ms，缓存只会带来过期状态。
- **链接是首选共享方式**：skill 目录用 Windows junction（`fs.symlinkSync(..., 'junction')`，不需管理员权限），提示词文件用硬链接（编辑任一端都改到同一份内容）。扫描的主轴因此是「链接 / 实体」，不是文件内容。删除源里的 skill 会先快照源目录与指向它的链接，再删源并移除这些链接；独立副本和指向别处的链接保留。
- **写路径先快照**：三个 skills 动作与两个提示词动作都先调用 `createSnapshot`，把受影响路径和将要新建的路径登记下来，失败也能还原。
- **提示词保存有乐观锁**：`GET /api/prompts/content` 返回 `etag`（文本 sha256；文件不存在时为 `missing`），`POST` 必须回传它；不一致返回 409 而不覆盖。前端遇到 409 会保留草稿、重新读取磁盘正文、亮出「载入磁盘版本」入口。省略 etag 时仍然写入（兼容旧调用方），但界面始终会传。
- **settings 写回是受控路径**：界面编辑用户级配置（`~/.claude/settings.json`、`~/.claude.json` 的 `mcpServers` 子树、`~/.codex/config.toml`、`~/.pi/agent/settings.json` 与 `mcp.json`）。字段目录由 `scripts/build-settings-catalog.mjs` 从 `schemas/` 的三份官方 schema 生成；保存先校验、再快照、最后临时文件 + rename 原子替换，etag 不一致返回 409。未知键原样保留；托管专用键只展示并标注。
- **模型应用是按 agent 格式打包写入**：`server/model-package.ts` 把 active provider + 选中模型写进选中的 agent：Claude Code 合并 `~/.claude/settings.json` 的 `env`（base URL 去掉末尾 `/v1`、`ANTHROPIC_AUTH_TOKEN`、model 与默认模型、网关/effort 开关）；Codex 合并 `~/.codex/config.toml` 的 `model_provider` / `[model_providers.agentmanager]` / `model` / `model_context_window`，保留现有 `model_catalog_json`；pi 合并 `~/.pi/agent/models.json` 的 `providers.agentmanager`（全部模型与能力）并设置 `defaultProvider` / `defaultModel`。Claude/Codex/pi settings 复用 settings 模块的 etag、校验、快照与原子写，pi models.json 走独立快照写入；只覆盖固定的 `agentmanager` provider 条目，其它 provider 原样保留。
- **模型 provider 是唯一模型源**：`~/.agents/providers.json` 保存多个 OpenAI 兼容 provider（base URL + API key），其中一个为 active；`server/providers.ts` 负责读写、切换、删除与模型读取，`server/models.ts` 只负责请求 `/models`、归一化与 60 秒缓存。API key 只在服务端用于请求，`GET /api/providers` 只返回 `hasApiKey`；Provider 页展示 active provider 的模型，设置页的 model 字段复用同一份候选。provider 文件写入前建快照，API key 尽量以 0600 权限保存。
- **MCP 用源文件 + 同步**：`~/.agents/mcp/servers.json` 保存归一化定义（transport/command/args/env/cwd/url/headers），三家 agent 的配置按各自格式物化。矩阵比较核心字段，忽略 Codex/pi 特有字段；状态为 synced/drift/missing/orphan/invalid/unsupported。源写入与 agent 写入都先快照；agent 侧复用 settings 的 etag/校验/原子写。MCP 无法像 skills 一样用链接共享，所以这里是「同步副本」而不是链接。
- **Hooks 用事件级源文件 + 同步**：`~/.agents/hooks/hooks.json` 按事件保存 `claude`/`codex` 的 matcher 组数组；Claude 写 `~/.claude/settings.json#hooks`，Codex 写 `~/.codex/hooks.json#hooks`。矩阵按事件比较；pi 无原生 hooks。Codex 修改 hooks 后需要用 `/hooks` 重新信任（哈希变化），同步时会提示。
- **前端用 Vite + React**：后续交互都带确认与回滚状态，比起服务端直出少一次重写。
- **样式是一套设计系统，不是逐页调色**：入口 `web/src/styles.css` 只按原级联顺序 `@import` `styles/tokens.css`、`base.css`、`shell.css`、`components.css`、`tables.css`、`styles/pages/*`、`save-bar.css`、`dialogs.css`、`responsive.css`。token 只在 `tokens.css` 定义，明暗两套只在 `:root`、`[data-theme='dark']` 与 `prefers-color-scheme` 三处赋值，其余规则一律引用变量。视觉方向是「墨与纸」：暖纸画布、墨色文字、印章红只用于注意/当前位置/危险，三个 agent 各有小方点身份色（Claude Code 陶土、Codex 苔绿、pi 石板蓝）。外壳是 224px 的文字索引侧栏 + 系统 UI 半粗页头 + 30px 底部状态条，侧栏与页面共用纸面底色；静态表面无阴影，只有对话框、浮层与保存条抬起；圆角 1–4px，每页只留一个墨色实心主按钮，「重新扫描」是描边次级按钮。页头只有半粗标题和一行说明；页面统一按「页头 → 工具区/图例 → 账页或表单 → 空态/最近操作」排布，表格行高 42px、首列冻结、列间有细线，商店是左侧目录筛选栏 + 右侧单列目录（内置技能是一块带底色的双列书架），设置页是 agent 页签 + 文件状态条 + 左索引 + 双列字段。底部状态条承载 agent 检测、提示词/MCP 摘要、主题、版本与退出；主题选择（浅色/深色/跟随系统）存在 `agentmanager.theme`，`base.css` 之前由 `web/index.html` 里的内联脚本先写入 `data-theme`，避免深色窗口首帧闪白。组件类名保持语义化单类（`.card`、`.field`、`.mcpm-table`），不使用 utility 类，也不在 TSX 里写内联样式；状态色只通过 `.state-*`、`.mcpm-*`、`.agent-*` 这类现有后缀类表达。改主题或调色只需动 token。设计约定见 `DESIGN.md`。
- **确认统一走模态对话框**：`web/src/lib/confirm.tsx` 提供 `useConfirmDialog()`，返回 `[ask, node]`；`ask({title, message, confirmLabel, danger, run})` 返回 `Promise<boolean>`。传 `run` 时写操作在对话框内执行，失败就地显示并可重试，成功才 resolve `true`；不传 `run` 时用户一应答就 resolve，由调用方自己显示进度（用于只改草稿的操作）。`danger` 时初始焦点落在「取消」，`Esc`/遮罩点击等同取消。对话框挂在 `components/ConfirmDialog.tsx`（原生 `<dialog showModal>`），并登记一个全局计数供 `isConfirmOpen()` 使用，避免 `Ctrl+S` 等全局快捷键在弹窗后面再次触发写操作。不要再新增 `window.confirm`。
- **内联表单关闭前先确认**：MCP 新增/编辑与 Hooks 新增/编辑面板都把「打开时的表单」序列化存在 `baselineRef` 里，`closeForm()` 对比当前值；有改动就用 `ask({danger:true})` 问一次，同时 `Esc` 与「取消」走同一个 `closeForm()`。没改动的表单直接关，不打扰。保存成功时先把基线与表单一起清掉，避免关面板时再问一次。
- **模型选择用 `components/ModelPicker.tsx`**：按钮 + 可筛选列表，支持 ↑/↓/Enter/Esc、自定义 ID 与清除；原生 `<datalist>` 在 100+ 选项时不可用（看不到上下文长度与能力，弹层不受控）。
- **漂移要一眼可见**：「需处理」只在一个地方定义——`web/src/lib/attention.ts` 的 `needsAttention`（除已同步/已链接/不支持/不适用之外的状态都算）。侧栏「状态」里的「需处理：Skills n · MCP n · Hooks n」按页计数，每个数字都是跳到该页的按钮；同样的计数出现在 Skills/MCP/Hooks 的图例里，点击图例即可把表格筛到该状态（Skills 是按 agent 筛出该 agent 仍需处理的行）。计数与筛选共用同一函数，所以侧栏说有几行，点进去筛出来就是几行。
- **Vite 锁在 7.x**：Vite 8（rolldown）无法解析 `react-dom/client` 里的相对 CJS 引用，构建失败；7.x 构建正常。
- **缓存用回收站代替快照**：`server/cache.ts` 按白名单列出各 agent 的会话记录与缓存（`~/.claude/projects`、`~/.codex/sessions`/`.tmp`、`~/.pi/agent/sessions` 等），清理只是把内容 `rename` 进 `<dataDir>/recycle/<id>/`（只有跨卷才复制），所以「清理」可回滚，「清空回收站」才是唯一的不可逆动作。请求只带目标 id，路径永远由服务端清单决定；glob 匹配会跳过 `PROTECTED_NAMES` 里的活配置文件，链接一律不跟随。年龄分档 [1,7,30,90] 天在一次遍历里算完，sqlite 的 `-wal`/`-shm` 与主文件同组，组内任一文件较新就整组跳过。

- **商店是注册表客户端，不是第二个源**：`server/store.ts` 只做两件事——把注册表目录读成页面能渲染的行，把选中的条目装进对应的唯一源。skill 走 skillstore.io：`/api/skills/<slug>/manifest` 给出目录名、ZIP 地址与 sha256，ZIP 由 `server/zip.ts` 解开（只认 store / deflate，读中央目录，不引依赖），先在 `<dataDir>/tmp` 里校验校验值、`SKILL.md` 与路径越界，再整体 `move` 进 `~/.agents/skills`，所以失败不会留下半个被扫描到的 skill；一次安装只建一个快照，`created` 覆盖新目录与它建的链接。MCP 走官方 Registry 的 `/v0/servers`：把 `packages` / `remotes` 翻译成中立的 `McpServerDefinition`，必填的 env / header / URL 变量（以及 header 值里的 `{token}` 模板）留给安装弹窗填写，再交给 `runMcpAction(saveSource)` 写进 `~/.agents/mcp/servers.json` 并同步所选 agent（快照由它负责）。两边的名字已存在时都 409 不覆盖——替换的取舍留给 Skills / MCP 页。清单内存缓存 60 秒，注册表 5xx 会重试，失败时回退上次结果并标 `stale`；`AGENT_MANAGER_STORE_URL` / `AGENT_MANAGER_MCP_STORE_URL` 可指向同接口的镜像。点卡片先打开预览：skill 按需请求 `/api/skills/<slug>` 取完整记录（能力 / 限制 / 使用场景 / 文件 / 安全审查），MCP 直接复用清单行里的 `options`，两边都不为了卡片多请求一次。
- **内置技能随应用分发，不依赖注册表**：原文件放在仓库 `builtin-skills/<slug>/`（目前是 skillify 与 cpp-windows-debug，均为 MIT），`scripts/build-exe.mjs` 把它们并入现有静态资源映射，`server/builtins.ts` 读取时资产映射优先于磁盘，所以升级后的 exe 不会混入旁边残留的旧目录。`GET /api/builtins` 直接返回完整预览（能力、限制、使用场景、文件行数），`POST /api/builtins/install` 复用商店抽出的 `installSkillEntries`——暂存校验 `SKILL.md`、单个快照、整体 move、建链失败回滚——内置与注册表安装因此共享同一条写入路径和同样的 409 语义。商店页把内置技能固定为 Skills 标签第一页顶部的独立栏（`.builtin-card` / `.builtin-action`，与注册表的 `.store-card` 分开），预览随列表一起到达、不联网；搜索时按名称 / 摘要 / 能力在本地匹配，翻页后不再重复显示。
- **商店页的中英文只翻译界面**：`web/src/lib/store-i18n.ts` 存商店页所有文案的两版，页面顶部切 `中文 / English / 双语`（默认中文，记在 localStorage）；分类与风险级别也走同一词典。skill 与 MCP server 自己的名字、描述与许可证保持发布者原文——翻译第三方内容会把“他到底写了什么”变得不可核对。

## Invariants

- 扫描不写任何文件；页面上的数字必须能在磁盘上复现。
- 每个写操作都可还原：配置类是快照，缓存类是回收站。
- 商店只往源目录与 `data/tmp/` 写；skill 内容永不执行，MCP server 不会被启动，不覆盖已有的同名条目。
- 配置文件永不写入；`POST /api/open` 只接受已知配置路径的白名单。
- API 只监听 `127.0.0.1`，请求体上限 1MB。Provider 的 API key 只在服务端使用，任何 GET 响应都不返回它。
- 新增 agent 只需在 `server/index.ts` 的清单里加一条 `{key, label, root}`，扫描逻辑不动。
- 前端不自己推导状态：格子显示的是后端给出的 `state`。
- 每个写操作都有确认入口，确认文案必须写明会改动/删除的具体路径；删除类操作的默认焦点是「取消」。

## Out of scope

- 项目级目录扫描（仓库内的 `.claude/`、`AGENTS.md`）。
- 多用户、远程访问、安装包、云端备份。
- 快照与回收站的自动清理与保留策略（`data/snapshots`、`data/recycle` 都由使用者手动释放）。
