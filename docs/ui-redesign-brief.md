# AgentManager 前端重设计简报

- 版本：1.0
- 日期：2026-11-02
- 范围：`web/` 的呈现层与交互层
- 性质：设计简报与实施记录（实现结果见附录 C）；功能清单基于重设计前的代码，样式与文件布局以附录 C 为准
- 取证基线：`web/src/App.tsx`、`web/src/views/*`、`web/src/components/*`、`web/src/lib/*`、`web/src/styles.css`、`web/src/api.ts`、`shared/types.ts`、`server/app.ts`、`README.md`、`architecture.md`、`scripts/ui-check.mjs`、`scripts/shots.mjs`

## 0. 一页结论

1. **功能已经完整，缺的是统一语法。** 七个页面各自实现了“页头 / 工具栏 / 表格 / 表单 / 反馈”，但彼此不是同一套组件语言：页头有五套写法，表单有四套结构，对话框只有一种外壳却承担三种用途（见 §2）。
2. **视觉方向推荐「冷峻工作台」。** 这个工具的核心任务是高密度矩阵诊断与路径核对，不是内容消费；冷色、低阴影、等宽路径、36–40px 行高比编辑部的宽松排版更贴合使用场景，也与现有 token 架构迁移成本最低（见 §3.5）。
3. **分 7 个波次落地，先把契约冻住。** `scripts/ui-check.mjs` 依赖大量类名与精确文案；任何重设计都必须先按 §5.1 的清单保留测试钩子，再按 §4 的顺序改共享文件，避免并行冲突。

---

## 1. 功能清单

### 1.1 全局外壳

入口是 `web/src/App.tsx`。页面通过 hash 切换（`App.tsx:114`、`App.tsx:121`、`App.tsx:197-221`），默认 `#skills`。

| 区域 | 现状实现 | 内容 | 依赖 |
| --- | --- | --- | --- |
| 左侧栏品牌 | `App.tsx:354-368`，`.brand` / `.brand-mark` / `.brand-copy` | 图标、AgentManager、副标题“本地配置” | — |
| 主导航 | `App.tsx:370-391`，`.side-nav` / `.nav-list[role=tablist]` / `.side-link` | 7 个页签：Skills、商店、MCP、Hooks、提示词、设置、缓存；按钮 id 为 `nav-<key>`，`aria-controls="workspace-panel"` | `TABS` (`App.tsx:41-84`) |
| 状态区 | `App.tsx:393-449`，`.side-agents` / `.side-summary` / `.side-attention` / `.side-agent` | 提示词摘要、MCP 摘要、需处理计数（每项是可点击按钮）、三个 agent 的检测状态与文件数、读取失败重试 | `promptSummary` (`App.tsx:255`)、`mcpSummary` (`App.tsx:261`)、`attention` (`App.tsx:265-272`)、`needsAttention` (`web/src/lib/attention.ts`) |
| 侧栏页脚 | `App.tsx:451-459`，`.side-foot` / `.side-version` | 版本号、服务 URL、退出程序（有确认框，`App.tsx:329-350`） | `GET /api/health`、`POST /api/app/quit` |
| 页头 | `App.tsx:463-487`，`.page-head` / `.page-title` / `.lede` / `.head-tools` / `.theme-switch` | 当前页标题与说明、主题切换（浅色/深色/跟随系统）、重新扫描 | `TABS`、`web/src/lib/theme.ts` |
| 工作区 | `App.tsx:489-523`，`main.workspace#workspace-panel[role=tabpanel]` | 全局 notice、当前视图、底部快照面板 | 各视图 props：`version`、`onChanged`、`onDirtyChange` 等 |
| 全局确认框 | `App.tsx:525` 的 `confirmNode`；`web/src/lib/confirm.tsx`、`web/src/components/ConfirmDialog.tsx` | 所有写操作的统一模态确认 | — |

跨页行为：

- **脏数据导航保护**：切换 hash 时，如果提示词或设置页有未保存草稿，先弹确认框，取消则把 hash 改回当前页（`App.tsx:197-221`）。
- **重新扫描**：`App.tsx:284-299`，有草稿时先确认放弃，否则递增 `dataVersion` 与 `snapshotVersion`。
- **主题**：`App.tsx:324`、`App.tsx:469-482`；取值 `light/dark/system`，存 `agentmanager.theme`（`web/src/lib/theme.ts`）。
- **快照面板**：每个页面底部都渲染 `SnapshotsPanel`（`App.tsx:522`、`web/src/views/SnapshotsPanel.tsx`），可展开、还原。
- **全局快捷键抑制**：确认框打开时 `isConfirmOpen()` 为真，`Ctrl+S` 不触发保存（`web/src/lib/confirm.tsx`、`PromptsView.tsx:76`、`SettingsView.tsx:386`）。

### 1.2 Skills（`#skills`）

**目的**：以矩阵形式展示每个 skill 在 Claude Code / Codex / pi 中的链接状态，并提供修复动作。

**可见区域**

- 来源与统计行：`SkillsView.tsx:218-222`，`.toolbar > .meta`，显示源路径、skill 数、行数、扫描耗时。
- 状态图例：`SkillsView.tsx:223-235`，`.legend`，含各状态色块与“≠ 副本与源不同”。
- 按 agent 筛选条：`SkillsView.tsx:255-286`，`.legend-bar`，每个 agent 一个 `.legend-filter`（带需处理计数），筛选后出现 `.legend-clear`。
- 矩阵表：`SkillsView.tsx:287-357`，`.table-wrap > table`；首列 skill 名，其后每 agent 一列，单元格为 `.cell.state-*`、`.cell-state`、可选 `.drift` 与 `.cell-actions`。
- 页面级错误、通知与空态：`SkillsView.tsx:238-254`。
- 全局快照面板：`App.tsx:522`。

**动作**

| 动作 | 触发 | 打开的表单/对话框 | 接口 |
| --- | --- | --- | --- |
| 建链（link） | 源里已有、agent 缺失时显示“建链” | `ConfirmDialog`：`CONFIRM.link` + `describeAction` 写明两端路径（`SkillsView.tsx:42-47`、`:59-121`） | `POST /api/skills`，action 见 `shared/types.ts` |
| 收进源（import） | 孤儿副本 | 同一个确认框，说明移动源目录并改链接 | 同上 |
| 删除副本（remove） | 副本状态 | 危险确认框，默认聚焦“取消” | 同上 |
| 移除坏链（unlink） | 失效链接 | 危险确认框，说明不会删除 skill 文件 | 同上 |
| 删除（源/agent） | 孤儿等其他状态 | 危险确认框 | 同上 |
| 筛选 | 点击 agent 图例 | 无 | 纯前端 `onlyAgent` 状态 |
| 清空筛选 | `.legend-clear` | 无 | 纯前端 |

**快捷键**：无页面专属快捷键；`Esc` 取消确认框；表格内按钮可 Tab 聚焦。

**依赖 API / 状态**：`GET /api/matrix`；组件内 `matrix`、`loading`、`busy`、`onlyAgent`、`notice`、`confirmNode`；`needsAttention` 与侧栏共用。

### 1.3 商店（`#store`）

**目的**：从 skillstore.io 与官方 MCP Registry 搜索并安装 skill / MCP server，同时选择要链接或同步的 agent。

**可见区域**

- 顶部工具区：`StoreView.tsx:313-372`，`.store-head`；内含 `.store-search`（Skills/MCP 切换 `.store-kinds`、输入框、提交按钮）、`.store-targets`（链接目标复选框）、`.store-lang`（中文/English/双语）。
- 结果元信息：`.store-page .meta`（ui-check 依赖，`ui-check.mjs:1332`）。
- 卡片网格：`StoreView.tsx:484`，`.store-grid > article.store-card`；卡片含标题、owner、徽标、摘要、安装按钮。
- 分页：`StoreView.tsx:639-663`，`.store-pager` / `.store-pager-label`；Skills 显示“第 N / M 页”，MCP 只显示“第 N 页”。
- 详情弹窗：`components/StoreDetailDialog.tsx`，`<dialog class="confirm-dialog store-detail-dialog">`。
- MCP 安装弹窗：`components/StoreMcpInstallDialog.tsx`，`.store-mcp-dialog`。

**动作**

| 动作 | 触发 | 打开的表单/对话框 | 接口 |
| --- | --- | --- | --- |
| 切换目录 | `.store-kinds` 按钮 | 无，重置搜索与页码 | `GET /api/store` |
| 搜索 | 回车或提交按钮；MCP 少于 3 字符不请求 | 无 | 同上 |
| 热门目录 | 清空搜索后浏览 | 无 | 同上 |
| 翻页 | 上一页/下一页 | 无 | 同上（MCP 用游标栈） |
| 选择目标 agent | `.store-targets .check` | 无 | 安装时随请求提交 |
| 切换语言 | `.store-lang button` | 无 | localStorage `agent-manager.store-lang` |
| 预览 | 点击卡片（Enter/空格） | `StoreDetailDialog`（skill 详情按需拉取） | `GET /api/store/skill` |
| 安装 skill | 卡片“安装” | 先 `ConfirmDialog`：owner/slug、绝对落点、会建的链接、风险、质量、快照；确认后请求 | `POST /api/store/install` |
| 安装 MCP | 卡片“安装” | `StoreMcpInstallDialog`：安装方式、名称、必填变量、sse 提示、目标 agent | `POST /api/store/install-mcp` |

**快捷键**：搜索框 Enter 提交；卡片 Enter/空格打开预览；`Esc` 关闭弹窗（`StoreDetailDialog.tsx:334-340`）。

**依赖 API / 状态**：`GET /api/store`、`GET /api/store/skill`、`POST /api/store/install`、`POST /api/store/install-mcp`；组件内 `kind`、`query`、`report`、`page/cursorStack`、`lang`、`targets`、`detailTarget`、`installTarget`、`busy`。

### 1.4 MCP（`#mcp`）

**目的**：维护 `~/.agents/mcp/servers.json` 单一源，并同步到三个 agent。

**可见区域**

- 页头：`McpView.tsx:453-467`，`.mcpm-page > .mcpm-head`；左侧源路径与统计，右侧 `.mcpm-head-actions`（新增 server、从现有配置导入、刷新）。
- 图例筛选：`McpView.tsx:487-515`，`.legend-bar`，按状态计数、点击筛选、`.legend-clear`。
- 矩阵表：`McpView.tsx:547`，`.mcpm-table`；列为 server、源、每个 agent、操作。
- 内联表单：`McpView.tsx:699-850`，`.mcpm-form` / `.mcpm-form-grid` / `.mcpm-sync` / `.mcpm-form-actions`；含名称、transport、command/args/env 或 url/headers、同步目标。
- 页面级错误、空态与快照面板。

**动作**

| 动作 | 触发 | 打开的表单/对话框 | 接口 |
| --- | --- | --- | --- |
| 新增 / 编辑 | `.mcpm-head-actions` 或行内动作 | 内联 `.mcpm-form`；关闭时如已修改，弹“放弃并关闭”确认 | `POST /api/mcp`（saveSource） |
| 从现有配置导入 | 页头按钮 | `ConfirmDialog`（`run`） | `POST /api/mcp`（importAll） |
| 同步 | 单元格“同步” | `ConfirmDialog`（`run`） | `POST /api/mcp`（sync） |
| 以此为准 | drift 单元格 | `ConfirmDialog` | `POST /api/mcp`（import） |
| 移除 | 单元格“移除” | 危险确认框 | `POST /api/mcp`（remove） |
| 刷新 | 页头按钮 | 无 | `GET /api/mcp` |
| 按状态筛选 | 点击图例 | 无 | 纯前端 |

**快捷键**：表单内 `Esc` 关闭；未修改直接关，已修改先确认（ui-check 17 段）。无 `Ctrl+S`。

**依赖 API / 状态**：`GET /api/mcp`、`POST /api/mcp`；`report`、`form`、`baselineRef`、`onlyState`、`busy`、`confirmNode`。

### 1.5 Hooks（`#hooks`）

**目的**：维护 `~/.agents/hooks/hooks.json` 事件级单一源，并同步到 Claude Code / Codex。

**可见区域**

- 页头：`HooksView.tsx:165-166`，复用 `.mcpm-head` / `.mcpm-head-copy` / `.mcpm-head-actions`；显示源路径、事件数、扫描时间、新增事件、从现有配置导入、刷新。
- 图例：`HooksView.tsx:169-191`，`.legend-bar` / `.hook-legend`，状态计数与 `.legend-clear`。
- 表格：`HooksView.tsx:194`，`.mcpm-table.hook-table`；列为 event、源、Claude Code、Codex、操作。
- 内联表单：`HooksView.tsx:276` 起的 `HookForm`，`.hook-form`。
- 页面级错误、空态与快照面板。

**动作**

| 动作 | 触发 | 打开的表单/对话框 | 接口 |
| --- | --- | --- | --- |
| 新增 / 编辑事件 | 页头或行内 | `.hook-form`；关闭时脏检查 | `POST /api/hooks` |
| 从现有配置导入 | 页头按钮 | `ConfirmDialog`（`run`） | `POST /api/hooks`（importAll） |
| 同步 / 收进源 / 移除 | 单元格 | `ConfirmDialog`（`run`） | `POST /api/hooks` |
| 刷新 | 页头 | 无 | `GET /api/hooks` |
| 按状态筛选 | 图例 | 无 | 纯前端 |

**快捷键**：`Esc` 关闭脏表单前确认（ui-check 17 段）。

**依赖 API / 状态**：`GET /api/hooks`、`POST /api/hooks`；`report`、`form`、`baselineRef`、`onlyState`、`busy`、`toast`。

### 1.6 提示词（`#prompts`）

**目的**：维护所有 agent 共用的全局提示词单一源，并把各 agent 的提示词文件对齐到它。

**可见区域**

- 工具行：`PromptsView.tsx:294-299`，`.toolbar > .meta`，显示源路径与字节数。
- 冲突提示：`PromptsView.tsx:311-318`，`.warning`，提供“载入磁盘版本”。
- 单一源编辑器卡片：`PromptsView.tsx:322-393`，`.card.editor-card`；标题、状态 tag（未保存/已保存/未建立）、路径、`#prompt-source-editor` 文本域、`.editor-actions`（打开文件、从 CLAUDE.md 初始化、保存并生效）。
- 各 agent 目标卡片：`.cards`，显示链接/副本/缺失状态与“对齐到源”动作。
- 全局快照面板。

**动作**

| 动作 | 触发 | 打开的表单/对话框 | 接口 |
| --- | --- | --- | --- |
| 编辑正文 | textarea | 无 | 本地状态 |
| 保存并生效 | 按钮或 `Ctrl+S` | 磁盘已变更时先确认覆盖 | `POST /api/prompts/content` |
| 打开文件 | 卡片按钮 | 无 | `POST /api/open` |
| 从 CLAUDE.md 初始化 | 源不存在时 | `ConfirmDialog` | `POST /api/prompts/action` |
| 对齐到源 | 目标卡片 | `ConfirmDialog`（覆盖时 danger，聚焦取消） | `POST /api/prompts/action` |
| 载入磁盘版本 | `.warning` 按钮 | 如有草稿先确认“放弃并载入” | `GET /api/prompts/content` |

**快捷键**：`Ctrl+S` 保存（仅在 dirty、非 busy、无确认框时，`PromptsView.tsx:71-82`）；`Esc` 取消确认框。

**依赖 API / 状态**：`GET /api/prompts`、`GET/POST /api/prompts/content`、`POST /api/prompts/action`、`POST /api/open`；`report`、`content`、`savedContent`、`busy`、`diskChanged`、`notice`、`error`。

### 1.7 设置（`#settings`）

**目的**：按 agent 编辑用户级配置文件、模型选择、MCP servers 与原始文件。

**可见区域**

- agent 切换：`SettingsView.tsx:1577-1601`，`.agent-switch`，三个 `.agent-tab`（检测点、名称、文件数）。
- 左侧内导航：`SettingsView.tsx:1604-1653`，`.settings-nav`，项为“模型 / 常用 / 各分组 / MCP servers / 原始文件”，每项带 `.nav-count`。
- 顶部工具：`SettingsView.tsx:1682` 起，`.settings-tools`，搜索框与“显示未设置项”。
- 消息区：`SettingsView.tsx:1713`，`.settings-messages`，冲突与提示。
- 内容区：模型面板、字段表单（`FieldEditor`）、MCP 编辑器（`McpEditor`）、原始文件编辑器（`RawEditor`）。
- 底部保存条：`SettingsView.tsx:1763`，`.save-bar`（未保存数、保存全部、放弃修改）。
- 全局快照面板。

**动作**

| 动作 | 触发 | 打开的表单/对话框 | 接口 |
| --- | --- | --- | --- |
| 切换 agent | `.agent-tab` | 有脏草稿时先确认 | `GET /api/settings` |
| 切换分区 | `.settings-nav .nav-item` | 无 | 本地导航状态 |
| 搜索字段 | `.settings-tools input[type=search]` | 无 | 本地过滤 |
| 选择模型 | `.model-picker-trigger` | `ModelPicker` 弹层（↑/↓/Enter/Esc） | `GET /api/models` |
| 编辑字段 | 各类控件 | 无 | 本地草稿 |
| 保存全部 | 按钮或 `Ctrl+S` | 托管键/可执行字段需二次确认；409 逐文件提示 | `POST /api/settings/save` |
| 放弃修改 | 保存条 | 确认 | 本地重置 |
| 编辑原始文件 | `.raw-card` | 遮罩预览 / 显示原文 | 本地草稿 |

**快捷键**：`Ctrl+S` 保存全部（`SettingsView.tsx:381-392`）；`ModelPicker` 内 ↑/↓/Enter/Esc；`Esc` 取消确认框。

**依赖 API / 状态**：`GET /api/models`、`GET /api/settings/catalog`、`GET /api/settings`、`POST /api/settings/save`；`catalog`、`report`、`drafts`、`issuesByFile`、`agentKey`、`nav`、`query`、`showUnset`、`saveState`、`messages`。

### 1.8 缓存（`#cache`）

**目的**：查看并清理各 agent 的会话记录与缓存，清理进入回收站，可恢复。

**可见区域**

- 工具行：`CacheView.tsx:310-330`，`.toolbar`，缓存合计、回收站占用、清理范围 `<select>`。
- 分组表：`CacheView.tsx:349-359`，`.cache-table`；每个 agent 一个 `tbody.cache-group` 与 `.cache-group-row`（合计、清理本组），其下列出各目标。
- 回收站面板：`CacheView.tsx:464` 起的 `.snapshots`，可展开、恢复、清空。
- 全局快照面板。

**动作**

| 动作 | 触发 | 打开的表单/对话框 | 接口 |
| --- | --- | --- | --- |
| 切换清理范围 | `.toolbar select` | 无 | 纯前端 |
| 清理单个目标 | 行内“清理” | `ConfirmDialog`：标题“清理缓存”，写明路径、文件数、体积，danger，默认取消 | `POST /api/cache` |
| 清理本组 | 组行“清理本组” | `ConfirmDialog`，列出全部路径 | 同上 |
| 恢复 | 回收站项“恢复” | `ConfirmDialog` | `POST /api/cache`（restore） |
| 清空回收站 | 面板标题按钮 | `ConfirmDialog`，标题“清空回收站”，写明不可恢复 | `POST /api/cache`（purge） |
| 打开路径 | 行内按钮 | 无 | `POST /api/open` |

**快捷键**：无页面专属；`Esc` 取消确认框。

**依赖 API / 状态**：`GET /api/cache`、`POST /api/cache`、`POST /api/open`；`report`、`ageDays`、`busy`、`notice`。

### 1.9 跨页能力与快捷键总表

| 能力 | 位置 | 行为 | 证据 |
| --- | --- | --- | --- |
| 侧栏需处理计数 | 侧栏“状态” | 按页计数，点击跳转；与图例筛选共用 `needsAttention` | `App.tsx:399-419`、`web/src/lib/attention.ts` |
| 主题切换 | 页头 | 浅色/深色/跟随系统，记忆到 localStorage | `App.tsx:469-482`、`web/src/lib/theme.ts` |
| 重新扫描 | 页头 | 有草稿先确认，递增版本号 | `App.tsx:284-299` |
| 退出程序 | 侧栏页脚 | 确认后 `POST /api/app/quit` | `App.tsx:329-350`、`:451-459` |
| 脏导航保护 | 全局 | 切换页签前确认 | `App.tsx:197-221` |
| 快照与还原 | 每页底部 | 还原前确认，danger | `SnapshotsPanel.tsx`、`POST /api/snapshots/restore` |
| 回收站 | 缓存页 | 清理 = 移动；恢复/清空 | `CacheView.tsx:464` 起 |
| 商店语言 | 商店页 | 中文/English/双语，仅商店页生效 | `web/src/lib/store-i18n.ts` |
| 打开文件/目录 | 提示词、缓存 | 白名单路径 | `POST /api/open` |
| 单实例 / 服务地址 | 侧栏页脚 | 显示运行端口 | `GET /api/health`、`architecture.md:29` |

| 快捷键 | 作用 | 触发条件 | 证据 |
| --- | --- | --- | --- |
| `Ctrl+S` / `Cmd+S` | 提示词保存 | 有修改、非 busy、无确认框 | `PromptsView.tsx:71-82` |
| `Ctrl+S` / `Cmd+S` | 设置保存全部 | 无确认框 | `SettingsView.tsx:381-392` |
| `Esc` | 取消确认框 | 对话框打开且非 busy | `ConfirmDialog.tsx:63-66` |
| `Esc` | 关闭 MCP / Hooks 表单 | 有修改时先确认 | `McpView`、`HooksView` 的 `closeForm` |
| `Enter` / 空格 | 打开商店卡片预览 | 卡片聚焦 | `README.md:21` |
| `↑` / `↓` / `Enter` / `Esc` | 模型选择器 | 弹层打开 | `components/ModelPicker.tsx` |
| `Enter` | 搜索框提交 | 商店页 | `StoreView.tsx:315` |

---

## 2. 现状问题

严重度：**高** = 阻碍重设计或明显影响可用性；**中** = 一致性问题；**低** = 打磨项。

| ID | 类别 | 问题 | 证据 | 严重度 |
| --- | --- | --- | --- | --- |
| P-01 | 布局/层级 | 页内“页头”有五套写法，标题、说明、操作的位置与间距不统一 | `App.tsx:463-487`、`StoreView.tsx:314`、`McpView.tsx:454`、`HooksView.tsx:166`、`SettingsView.tsx:1578` | 高 |
| P-02 | 文案 | 页头说明过长且中英混排，描述实现而不是用户目标 | `App.tsx:46-82`，尤其 `:52` | 高 |
| P-03 | 导航 | 7 个页签平铺，无分组；需处理计数在导航下方的“状态”块里，入口与提醒分离 | `App.tsx:370-391`、`:393-419` | 高 |
| P-04 | 表格 | 表格强制 `min-width: 640px`，窄窗口只能横向滚动；表头双行、10px 计数 | `styles.css:1100-1102`、`:1104-1118`、`:1152-1161` | 高 |
| P-05 | 表格 | 单元格内状态与操作按钮同时常显，信息噪声大 | `SkillsView.tsx:313-347`、`CacheView.tsx:380-392` | 高 |
| P-06 | 表单 | 四套表单结构并存：`.field`、`.server-form`、`.mcpm-form`、`.hook-form` | `FieldEditor.tsx`、`McpEditor.tsx`、`McpView.tsx:699-850`、`HooksView.tsx:276` | 高 |
| P-07 | 对话框 | 所有对话框共用 `.confirm-dialog`，再按用途打补丁宽度：480/600/680px | `styles.css:3297-3305`、`:3633-3643`、`:3687-3689` | 中 |
| P-08 | 设置 | 双层导航（agent 标签 + 内部分区）视觉语言不同；页面 1809 行 | `SettingsView.tsx:1577-1653`、文件总行数 | 高 |
| P-09 | 响应式 | ≤960px 时保存条改为 `position: static`，主操作会滚出视口 | `styles.css:3969-3975`；`SettingsView.tsx:1763` | 高 |
| P-10 | 可访问性 | 浅色下 `--text-dim #6d7987` 在白色上约 4.4:1、在 `--surface-2` 上约 4.1:1，低于 AA；用于 10–11.5px 文本 | `styles.css:21`、`:1112`、`:1157` | 高 |
| P-11 | 可访问性 | Skills / 缓存表没有 `<caption>`，MCP / Hooks 有；表头语义不一致 | `SkillsView.tsx:289`、`CacheView.tsx:350`、`McpView.tsx:548`、`HooksView.tsx:194` | 中 |
| P-12 | 可访问性 | 导航使用 `role="tablist"/tab`，但没有实现方向键切换；窗口标题不随页签变化 | `App.tsx:370-389`；`web/src` 无 `document.title` 赋值 | 中 |
| P-13 | 反馈 | notice / error / warning / toast 的挂载位置与生命周期不统一 | `App.tsx:496`、`SkillsView.tsx:246`、`PromptsView.tsx:309-318`、`SettingsView.tsx:1713`、`styles.css:3227` | 中 |
| P-14 | 视觉一致性 | token 只有颜色/圆角/阴影，字号、间距、行高、动效散落硬编码 | `styles.css:7-55`；`:327-331`、`:587-598`、`:1108-1118` | 高 |
| P-15 | 工程结构 | 单文件 4104 行 CSS；Hooks/MCP 的 JSX 被压成超长单行，重设计编辑风险高 | `styles.css`（4104 行）、`HooksView.tsx:166`、`:194` | 高 |
| P-16 | 视觉一致性 | 侧栏渐变、品牌渐变、卡片阴影、表格阴影、弹窗大阴影混用，层次偏重 | `styles.css:281-293`、`:304-314`、`:1085-1092`、`:3297-3305` | 低 |
| P-17 | 信息架构 | 页头说明、工具行 meta、侧栏摘要重复描述同一组数据 | `App.tsx:58` 与 `McpView.tsx:455`；`App.tsx:396-397` | 中 |

### 2.1 页头与层级

`App.tsx:463-487` 已经提供了一个全局页头：`h1` 21px、`.lede` 13px / 76ch、右侧主题与重新扫描（`styles.css:572-599`）。但页面内部又各自造头：

- 商店 `.store-head` 同时装搜索、目标、语言（`StoreView.tsx:314-372`）；
- MCP / Hooks `.mcpm-head`（`McpView.tsx:454`、`HooksView.tsx:166`）；
- 设置 `.agent-switch`（`SettingsView.tsx:1578`）；
- Skills 与缓存只有 `.toolbar`（`SkillsView.tsx:218`、`CacheView.tsx:310`）。

结果是：用户从一页到另一页时，“标题—说明—操作—筛选”的相对位置会跳动；同时全局 `.lede` 与页内 `.meta` 又说了一遍同样的事。

### 2.2 导航与状态

主导航是 7 个同权重按钮（`App.tsx:370-391`），没有分组标签，也没有在导航项上显示异常计数。异常计数被放在下方“状态”区（`App.tsx:399-419`），且以句子形式呈现：

> 需处理：Skills 2 · Hooks 2

按钮本身很小，数字与标签之间靠 `·` 分隔。窄屏时侧栏折成顶部横条，状态区被推到导航下方（`styles.css:3867-3930`），进一步拉开入口与提醒的距离。

### 2.3 表格密度

- `.table-wrap table { min-width: 640px }`（`styles.css:1100-1102`）。Skills 有 1 + 3 列，MCP / Hooks 有 1 + 1 + 2 + 1 列，缓存有 3–5 列；在 680px 以下只能横向滚动。
- 表头 `padding: 9px 14px`、`font-size: 11.5px`、`text-transform: uppercase`（`styles.css:1104-1118`）。中文表头不受 uppercase 影响，但英文表头 `skill` / `event` 与中文表头混排（`SkillsView.tsx:292`、`HooksView.tsx:194`）。
- 第二行计数只有 10px（`styles.css:1152-1161`），是表头里最弱的信息。
- Skills 每个单元格同时渲染 `.cell-state` 和最多两个文字按钮（`SkillsView.tsx:313-347`）；一屏 10 行 × 3 列时会同时出现大量按钮，状态反而被淹没。

### 2.4 表单与对话框

- `FieldEditor.tsx`（1274 行）定义 `.field` / `.field-head` / `.field-label` / `.field-control`；`McpEditor.tsx`（791 行）用 `.server-form` / `.form-grid` / `.string-map`；MCP 页的内联表单用 `.mcpm-form`（`McpView.tsx:699-850`）；Hooks 用 `.hook-form`（`HooksView.tsx:276`）。同一件事（写一个键值、一个数组、一个密钥）有四种视觉表达。
- 确认框统一在 `ConfirmDialog.tsx`，宽 480px（`styles.css:3297-3305`）；商店详情把它覆盖到 680px（`styles.css:3687-3689`），MCP 安装覆盖到 600px（`styles.css:3633-3643`）。三种内容密度共用一个 `h2 + body + actions` 结构，长内容的滚动与分区只能靠页面级补丁。
- 对话框的焦点管理本身是好的：danger 时聚焦取消（`ConfirmDialog.tsx:38-47`），失败信息显示在框内（`ConfirmDialog.tsx:73-77`），写操作在框内执行并可重试。这一套必须保留（见 §5.2）。

### 2.5 文案与双语

- 全局 UI 是中文，但领域词混用英文：`skill`（`App.tsx:46`）、`MCP server`（`App.tsx:58`）、`server`（`McpView.tsx:464` 附近）、`event`（`HooksView.tsx:194` 表头）、`hooks`（`App.tsx:64`）。
- 商店页支持中文 / English / 双语（`StoreView.tsx:365`、`web/src/lib/store-i18n.ts`），但该开关不影响侧栏、页头与其它页面，切到 English 后页面一半英文一半中文。
- 页头说明 `App.tsx:52` 是中文长句后直接接英文长句，宽度上限 76ch（`styles.css:595`），在 1400px 窗口里占三行。

### 2.6 响应式

断点只有 1180 / 960 / 680（`styles.css:3861`、`:3867`、`:3978`），且主要做“折叠布局”而不是“重排信息”：

- ≤960：侧栏变顶栏、导航横向滚动（`:3900-3910`），状态区独占一行（`:3912-3921`），页头纵向堆叠（`:3940-3949`）。
- ≤680：工具栏纵向堆叠（`:4050-4053`），表单网格变单列（`:4027-4032`），对话框按钮换行（`:4045-4048`），但表格仍保持 640px 最小宽度（`:1100`）。
- 设置页保存条在 ≤960 变为 `position: static`（`:3969-3975`），当表单很长时，“保存全部”只在最底部出现；脏状态也随之不可见。

### 2.7 可访问性

- **对比度**：`--text-dim: #6d7987`（`styles.css:21`）与白色的对比约 4.4:1，与 `--surface-2: #f2f5f9` 约 4.1:1；它被用在 11.5px 表头和 10px 计数上（`styles.css:1112`、`:1157`），不满足 WCAG AA 的 4.5:1。
- **表格标题**：Skills 与缓存表没有 `<caption>`；MCP 与 Hooks 有 `.sr-only` caption（`McpView.tsx:548`、`HooksView.tsx:194`）。
- **导航语义**：`role="tablist"` 的按钮没有实现 `ArrowUp/ArrowDown` 切换（`App.tsx:370-389`），与 ARIA tabs 模式不一致；改成 `<nav>` + `aria-current="page"` 更贴合“页面导航”而不是“选项卡”。
- **标题**：没有随页签更新 `document.title`；应用窗口没有地址栏，任务栏与窗口切换器里始终只显示 `AgentManager`（`web/index.html`）。
- **状态说明**：Skills 单元格把详细说明放在 `title` 属性里（`SkillsView.tsx:313`），键盘用户无法主动读到；屏幕阅读器只能读到 `SHORT` 映射的一两个字（`SkillsView.tsx:8-24`）。

### 2.8 视觉一致性

现有 token 是好的起点：一份色板、明暗两套、语义单类（`styles.css:7-133`、`architecture.md:42`）。问题在于 **token 的边界只到颜色/圆角/阴影**：

- 字号：21px（`styles.css:588`）、14.5px（`:328`）、13.5px（`:1128`）、13px（`:597`）、12.5px（`:1138`）、11.5px（`:1112`）、10px（`:1157`）散落各处。
- 间距：9px 14px、18px 12px 14px、20px clamp(...) 18px 等（`styles.css:289`、`:578`、`:1108`）。
- 动效：0.13s、0.12s 等直接写在规则里（`styles.css:363`、`:680` 附近）。
- 阴影：侧栏渐变（`:291-293`）、品牌渐变（`:311`）、卡片 `--shadow-xs`、弹窗 `--shadow-pop` 同时存在；整体偏低对比但层数多。

---

## 3. 重设计提案

### 3.1 信息架构与导航分组

保留 7 个页面、全部 hash 与 `nav-<key>` id；只改变分组、顺序与呈现。分组依据是“用户来这一页要做的决定”，不是后端模块：

```
管理资产
  Skills        #skills    每个 agent 里到底有什么
  商店          #store     从哪里获取新资产
维护单一源
  提示词        #prompts   一份正文，多个链接
  MCP           #mcp       一份定义，多个副本
  Hooks         #hooks     一份事件，多个副本
本机维护
  缓存          #cache     占了多少空间，能删什么
  设置          #settings  每个 agent 的原始配置
```

- 组标题用 11px 大写/字距标签（中文用 11px + `--text-dim`，不做 uppercase）。
- 导航项右侧显示异常计数 pill（仅当 >0）；数据仍来自 `attention`，点击行为与现在一致。
- 保留侧栏“状态”块（`.side-attention`），因为 ui-check 依赖它的按钮文本（`ui-check.mjs:680-696`）；但把它收成一张紧凑卡片，标题“需处理”，下面是三个可点击行，而不是一句话。
- 顺序调整只影响 `TABS` 数组（`App.tsx:41-84`），不影响 hash。

### 3.2 应用外壳

```
┌───────────────────────┬──────────────────────────────────────────────────────────┐
│ brand                 │  PageHeader（App 渲染）                                  │
│ AgentManager          │  eyebrow 管理资产                                       │
│ 本地配置               │  Skills                          [浅|深|系统] [重新扫描] │
│                       │  查看每个 skill 在三个 agent 中的链接状态。              │
│ 管理资产               ├──────────────────────────────────────────────────────────┤
│  ▸ Skills        (2)  │  PageToolbar（页面渲染）                                 │
│    商店                │  源 ~/.agents/skills · 12 个 skill · 12 行 · 18ms        │
│                       │                              [按 agent 筛选] [刷新]     │
│ 维护单一源             ├──────────────────────────────────────────────────────────┤
│    提示词              │                                                          │
│    MCP           (1)  │  ContentSurface                                          │
│    Hooks         (2)  │  ┌────────────────────────────────────────────────────┐  │
│                       │  │ DataTable / Cards / Editor / Form                  │  │
│ 本机维护               │  └────────────────────────────────────────────────────┘  │
│    缓存                │                                                          │
│    设置                │  SnapshotsPanel（折叠条，贴底）                           │
│                       │                                                          │
│ 需处理                 │                                                          │
│  Skills 2  Hooks 2    │                                                          │
│  ● Claude Code  8/8   │                                                          │
│  ● Codex        5/6   │                                                          │
│  ● pi           3/3   │                                                          │
│  v0.1.0 · 127.0.0.1   │                                                          │
└───────────────────────┴──────────────────────────────────────────────────────────┘
```

尺寸与行为：

- 侧栏固定 232px（现 244px，`styles.css:50`）；`position: sticky` 的内部滚动只发生在导航与状态区之间，页脚贴底。
- 页头高 56–72px，随内容自适应；`h1` 20px/600，eyebrow 11px，lede 13px 单行优先、最多两行（用 `-webkit-line-clamp: 2`，不做 76ch 硬上限）。
- 工作区内容最大宽度 1360px，左右 `clamp(16px, 2.2vw, 28px)`；表格与表单不再各自设宽。
- 页头右侧只放全局动作（主题、重新扫描）；页面级动作一律下移到 PageToolbar，避免“保存/导入”和“重新扫描”混在同一行。
- ≤960：侧栏变成顶部横向导航（保留现有折叠思路），但状态卡改为可展开的 `details`，默认收起，减少首屏占用。

### 3.3 统一页面语法

所有页面按同一顺序组合，页面只负责“选择哪种内容面”：

```
PageHeader      App 统一渲染：eyebrow / h1 / lede / 全局动作
PageToolbar     页面渲染：左侧 meta/统计，右侧主次动作
FilterBar       可选：图例/筛选 chip + 计数 + 清除
ContentSurface  DataTable | CardGrid | SplitEditor | Form
Feedback        inline notice / error / warning（内容顶部，单一栈）
SnapshotsPanel  全局，贴工作区底部
```

**PageToolbar**

- 左：`.meta` 一行，路径用 mono，计数用 `·` 分隔；超长路径 `text-overflow: ellipsis`，完整值放 `title`。
- 右：最多 1 个 primary + 2 个 secondary；更多动作进 `⋯` 菜单（仅当动作数 ≥4）。
- 不再出现“标题在页头、动作在页内头、筛选又在另一行”的三段式。

**FilterBar**

- 图例即筛选：每个 chip 含“色块 + 状态名 + 计数”，`aria-pressed` 保留；一行放不下时换行，不横向滚动。
- 激活筛选后，右侧显示“显示全部 N 行”（保留 ui-check 需要的 `.legend-clear` 文案与类名）。
- 计数与侧栏共用 `needsAttention`，不新增计算逻辑。

**DataTable**

- 表头 36px，行 40px（紧凑模式 36px）；字号 12.5px，首列 13px。
- 首列 `position: sticky; left: 0`，背景 `--surface`；表头 `top: 0`，两者 z-index 分层。
- 表头只允许一行：`Claude Code` 下方用 10.5px 的“11 生效”放在同一单元格内，不换行；数字不再单独占一行大块。
- 状态 = 16px 字形 + 12px 文字（✓ 链接 / ◐ 副本 / ○ 缺失 / ! 坏链 / + 孤儿 / – 不支持）。颜色只作辅助，文字始终存在。
- 操作按钮默认 `opacity: .55`，行 hover / `focus-within` 时 `opacity: 1`；不能用 `display: none`，否则键盘和测试都拿不到。
- 所有表格加 `.sr-only` caption；Skills 与缓存补齐（P-11）。
- 窄屏（<720px）允许 `.table-wrap` 横向滚动，但冻结首列，并给 `.table-wrap` 加 `scrollbar-gutter: stable`。

**CardGrid（商店）**

- 卡片固定信息顺序：标题 + owner → 徽标行 → 摘要（2 行截断）→ 底部动作。
- 卡片高度一致；`grid-template-columns: repeat(auto-fill, minmax(272px, 1fr))`；间距 16px。
- 安装按钮是卡片内唯一 primary；预览通过点击卡片触发，不再额外放“详情”按钮。

**SplitEditor（提示词）**

```
┌──────────────────────────────────────────────┬──────────────────────┐
│ 单一源正文            [未保存]                │ 链接目标              │
│ ~/.agents/prompts/global.md                  │ ┌ Claude Code  已链接 │
│ ┌──────────────────────────────────────────┐ │ │ /…/CLAUDE.md  [打开]│
│ │ textarea（自适应高度，最少 18 行）        │ │ └────────────────────│
│ │                                          │ │ ┌ Codex       副本 ≠ │
│ └──────────────────────────────────────────┘ │ │ [对齐到源]          │
│ 1,234 字节 · 有未保存的修改    [保存并生效]  │ └────────────────────│
└──────────────────────────────────────────────┴──────────────────────┘
```
≥1180px 两栏；以下堆叠，目标卡片变成横向 chip 行。

**Form**

- 字段结构统一为：label（12.5/500）→ control（32px 高）→ description（12px，`--text-dim`）→ error（12px，danger）。
- 2 列网格在 ≥960px；label 在上，不用 placeholder 代替 label。
- 分组卡片：标题 14px/600 + 可选说明；组内字段间距 12px，组间 24px。
- 密钥字段统一“•••• + 显示/隐藏”按钮；保留 `autocomplete="off"`。
- 底部 sticky 保存条：左侧“3 个文件有未保存修改”，右侧“放弃修改 / 保存全部”；sticky 相对内容区，手机端也可见。

**Dialog**

- 统一 `<dialog class="confirm-dialog">` 外壳，新增 `data-size="sm|md|lg"`：
  - sm 440px：确认、删除；
  - md 640px：MCP 安装、导入；
  - lg 960px：商店详情、原始文件预览。
- 结构固定：header（标题 + 关闭）→ body（可滚动，`max-height: 72vh`）→ footer（取消在左、主操作在右）。
- danger 仍默认聚焦“取消”；`Esc` / 遮罩取消；失败信息仍用 `.confirm-dialog-error`；busy 时禁止关闭。
- 长内容按 section 分组，section 标题 12px 大写/字距；不再把整页信息塞进一个 13px 段落。

**Feedback**

- 内容顶部只有一个反馈栈：`.notice`（成功/信息）、`.warning`（需要决定）、`.error`（失败 + 重试）。
- Toast 只用于“保存成功”这类瞬时反馈（设置页已有 `.toast`），同一事件不同时出现 notice 和 toast。
- 所有反馈容器带 `role="status"` 或 `role="alert"`，并保持与现有 ui-check 文本一致。

### 3.4 新 token 集

目标：把“颜色之外”的设计决定也收进 token；颜色变量名保持，值可整体替换。

```css
:root {
  color-scheme: light;

  /* 画布与表面 */
  --bg: #f3f5f8;
  --surface: #ffffff;
  --surface-2: #f6f8fa;
  --surface-3: #eceff3;
  --surface-sunken: #edf0f4;

  /* 边线 */
  --border: #dfe4ea;
  --border-strong: #c4ccd6;

  /* 文字：--text-dim 在白色上约 5.4:1，在 --bg 上约 5.0:1 */
  --text: #0b1220;
  --text-muted: #44505f;
  --text-dim: #5e6b7a;

  /* 强调 */
  --accent: #2f54eb;
  --accent-strong: #2443c4;
  --accent-soft: #eef1fe;
  --accent-contrast: #ffffff;

  /* 语义 */
  --danger: #b42318;
  --danger-soft: #fef3f2;
  --warning: #8a4b00;
  --warning-soft: #fff6e8;
  --success: #067647;
  --success-soft: #ecfdf3;
  --info: #175cd3;
  --info-soft: #eff8ff;

  /* 字体 */
  --font-sans: 'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei',
    'PingFang SC', system-ui, sans-serif;
  --font-mono: 'Cascadia Mono', 'Cascadia Code', 'Consolas', 'Microsoft YaHei UI', ui-monospace,
    monospace;
  --font-display: var(--font-sans);

  --fs-2xs: 10.5px;
  --fs-xs: 11.5px;
  --fs-sm: 12.5px;
  --fs-base: 13.5px;
  --fs-md: 14.5px;
  --fs-lg: 16px;
  --fs-xl: 20px;
  --fs-2xl: 26px;

  --lh-tight: 1.2;
  --lh-snug: 1.4;
  --lh-normal: 1.55;

  --fw-regular: 400;
  --fw-medium: 500;
  --fw-semibold: 600;
  --fw-bold: 700;

  --tracking-caps: 0.06em;

  /* 间距（4px 基数） */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-7: 32px;
  --space-8: 40px;
  --space-9: 48px;
  --space-10: 64px;

  /* 圆角：沿用原变量名，只改值 */
  --radius-xs: 4px;
  --radius-sm: 6px;
  --radius: 10px;
  --radius-lg: 14px;
  --radius-xl: 18px;
  --radius-full: 999px;

  /* 阴影：更薄，弹窗除外 */
  --shadow-xs: 0 1px 0 rgba(11, 18, 32, 0.04);
  --shadow-sm: 0 1px 2px rgba(11, 18, 32, 0.06), 0 1px 3px rgba(11, 18, 32, 0.04);
  --shadow-md: 0 8px 24px -12px rgba(11, 18, 32, 0.18);
  --shadow-pop: 0 24px 64px -24px rgba(11, 18, 32, 0.32), 0 2px 8px rgba(11, 18, 32, 0.08);

  /* 锐利焦点环 */
  --ring: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);

  /* 动效 */
  --ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);
  --dur-fast: 120ms;
  --dur-base: 180ms;

  /* 布局 */
  --sidebar-width: 232px;
  --topbar-height: 56px;
  --content-max: 1360px;
  --gutter: clamp(16px, 2.4vw, 28px);
  --row-height: 40px;
  --row-height-compact: 36px;
  --control-height: 32px;

  /* 层级 */
  --z-sticky: 10;
  --z-sidebar: 20;
  --z-popover: 40;
  --z-dialog: 60;
  --z-toast: 70;
}
```

深色保持三个赋值点不变（`:root`、`@media (prefers-color-scheme: dark)`、`[data-theme='dark']`，见 `styles.css:57-133`），值如下：

```css
--bg: #0b0f14;
--surface: #121821;
--surface-2: #18202b;
--surface-3: #202a36;
--surface-sunken: #0e131a;

--border: #26313d;
--border-strong: #3a4756;

--text: #e9eef4;
--text-muted: #a9b5c2;
--text-dim: #8492a2;

--accent: #8ca3ff;
--accent-strong: #b3c2ff;
--accent-soft: #18224a;
--accent-contrast: #071021;

--danger: #f97066;
--danger-soft: #2e1715;
--warning: #f5b547;
--warning-soft: #2b2213;
--success: #47cd89;
--success-soft: #0f2a1d;
--info: #84adff;
--info-soft: #132038;

--shadow-xs: 0 1px 0 rgba(0, 0, 0, 0.35);
--shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4), 0 1px 3px rgba(0, 0, 0, 0.3);
--shadow-md: 0 10px 28px -14px rgba(0, 0, 0, 0.7);
--shadow-pop: 0 28px 72px -24px rgba(0, 0, 0, 0.9), 0 2px 10px rgba(0, 0, 0, 0.6);
```

迁移规则：

1. 旧变量名 `--radius` / `--radius-lg` / `--shadow-*` / `--ring` 全部保留，只改值；组件 CSS 不需要改引用。
2. 新字号/间距变量先用于新规则，旧规则在各自波次中替换；不要求一次改完。
3. 明暗两套只有这三处赋值；禁止在组件规则里写颜色字面量（`architecture.md:42` 的约束）。

### 3.5 两个视觉方向

#### 方向 A：冷峻工作台（推荐）

- **关键词**：仪表盘、纸面白/石墨黑、钴蓝单强调、等宽路径、低阴影、36–40px 行。
- **表面**：侧栏与内容同色系，靠 1px 边线分区；卡片只在需要分组时出现，不用阴影堆层次。
- **类型**：全部无衬线；标题 600、正文 400；路径、skill 名、MCP id 一律 mono。
- **状态**：语义色只用于字形与 2–4px 边条；大面积保持中性。
- **动效**：120ms，只做背景/透明度。
- **气质**：像一台校准过的仪器，长时间盯着不累；适合矩阵与设置表单。

#### 方向 B：温暖编辑部

- **关键词**：纸感、墨色、衬线标题、陶土色强调、宽松行距、卡片式浏览。
- **表面**：`--bg: #f7f3ec`、`--surface: #fffcf5`；边线偏暖；卡片圆角 16–18px，轻阴影。
- **类型**：标题用 `'Source Han Serif SC', 'Noto Serif SC', 'Songti SC', serif`，正文仍用无衬线；行高 1.65。
- **颜色**：`--accent: #b4462b`（陶土）、`--success: #3f6b4e`（苔绿）、`--info: #3d5a80`（灰蓝）。
- **密度**：行高 44px，表单间距 16px，页面留白 32–48px。
- **气质**：像一本产品目录，商店页会很好看；但在 10 行 × 3 agent 的矩阵里会显得空、慢，且需要引入衬线中文字体（体积与加载成本）。

#### 推荐：A

理由：

1. **任务匹配**：这个前端的核心是“对照矩阵 + 路径核对 + 批量同步”，密度与扫读优先；A 的 36–40px 行、mono 路径、低噪声状态更适合 `SkillsView.tsx:287-357`、`McpView.tsx:547` 这类表格。
2. **迁移成本最低**：现有 token 已是冷色系（`styles.css:10-35`），A 只调整色值与新增字号/间距变量；B 要替换整套色板、引入衬线字体并重排所有卡片，回归面大。
3. **明暗一致性**：A 的中性色在暗色下只需反转层级；B 的暖色在暗色里很容易变成“棕色糊”，需要更多单独调校。
4. **窗口形态**：应用窗口常与编辑器并排，低 chrome、低阴影减少视觉竞争；B 的编辑感在独立阅读时更好，但不适合常驻工具。
5. **可访问性**：A 的高对比中性色更容易满足 4.5:1；B 的暖灰文字在纸色背景上需要逐一验证。

**例外**：商店页可以在 A 的壳内借用 B 的卡片节奏（更大的标题、更多留白），但不换色板与字体；这样既保留浏览的愉悦感，又不破坏全局一致性。

### 3.6 逐页线框

#### Skills

```
PageHeader   Skills · 查看每个 skill 在三个 agent 中的链接状态
PageToolbar  源 ~/.agents/skills · 12 个 skill · 12 行 · 18ms        [刷新]
FilterBar    [Claude Code 3] [Codex 2] [pi 1]          显示全部 12 行
┌ skill ─────────────┬ Claude Code 11 生效 ┬ Codex 10 生效 ┬ pi 9 生效 ┐
│ alpha              │ ✓ 链接              │ ✓ 链接        │ ✓ 链接      │
│ beta               │ ◐ 副本 ≠  [删除副本] │ ○ 缺失        │ + 孤儿      │
│                    │                    │               │ [收进源][删]│
└────────────────────┴────────────────────┴───────────────┴─────────────┘
SnapshotsPanel ▸ 最近操作
```

关键改动：

- 图例与 agent 筛选合并为一行 FilterBar；状态字形 + 文案，颜色只辅助。
- 首列冻结；表头单行；操作按钮在行 hover/focus 时增强，但始终可达。
- 空态给出“去商店安装”的唯一主行动（保留现有链接语义，`SkillsView.tsx:250-254`）。
- 不新增批量选择、不新增排序。

#### 商店

```
PageHeader   商店 · 从两个注册表安装 skill 与 MCP server
PageToolbar  [Skills | MCP]  [搜索…                    ] [搜索]
             安装后链接到  [✓ Claude] [✓ Codex] [✓ pi]      [中文|EN|双语]
Content      第 1 / 3 页 · 共 50 条 · 更新于 12:40
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ latte        │ │ …            │ │ …            │
│ acme/acme-…  │ │              │ │              │
│ [office][safe│ │              │ │              │
│ 摘要两行……    │ │              │ │              │
│        [安装] │ │              │ │              │
└──────────────┘ └──────────────┘ └──────────────┘
Pager        [上一页] 第 1 / 3 页 [下一页]
```

关键改动：

- 顶部分两行：第一行目录切换 + 搜索；第二行目标 + 语言。窄屏时各自成行。
- 卡片高度统一、摘要 2 行截断；安装是唯一 primary。
- 分页保持“第 N / M 页”文案；MCP 仍只显示“第 N 页”。
- 语言开关只影响商店文案（保持 `store-i18n.ts` 的边界）。

#### MCP

```
PageHeader   MCP · 一份定义，同步到三个 agent
PageToolbar  源 ~/.agents/mcp/servers.json · 6 个 server      [新增 server] [导入] [刷新]
FilterBar    [已同步 4] [有差异 1] [缺失 1] [孤儿 0] …
┌ server ─────────┬ 源 ┬ Claude Code ┬ Codex ┬ pi ┬ 操作 ┐
│ filesystem      │ ✓  │ ✓ 已同步    │ ✓     │ ✓  │ 移除 │
│ github          │ ✓  │ ◐ 有差异    │ ○     │ +  │ 同步 │
└─────────────────┴────┴─────────────┴───────┴────┴──────┘
[ 编辑面板：名称 / transport / command 或 url / env / 同步目标 ]  (宽屏右侧 420px 抽屉，窄屏内联)
```

关键改动：

- 页头动作统一为 toolbar 右侧；表格不再被表单顶下去。
- 编辑表单在 ≥1280px 变为右侧抽屉；<1280px 回到表格上方的卡片。两种形态都保留 `.mcpm-form`、`.mcpm-form-actions` 与 `filesystem` placeholder（ui-check 依赖）。
- 状态列与操作列分开；操作按钮语义不变。

#### Hooks

```
PageHeader   Hooks · 一份事件源，同步到 Claude Code 与 Codex
PageToolbar  源 ~/.agents/hooks/hooks.json · 4 个事件            [新增事件] [导入] [刷新]
FilterBar    [已同步 2] [有差异 1] [孤儿 2] [缺失 0] …
┌ event ──────────┬ 源 ┬ Claude Code ┬ Codex ┬ 操作 ┐
│ SessionStart    │ ○  │ + 孤儿      │ + 孤儿│ 收进源│
│ PermissionReq.  │ ✓  │ ✓          │ —     │ 编辑  │
└─────────────────┴────┴─────────────┴───────┴──────┘
```

关键改动：

- 与 MCP 共用表格/筛选/表单视觉，但使用 `hook-` 语义类；现有 `.mcpm-*` 在迁移期双写。
- 表头 `event` 改为“事件”，中文界面不混英文表头；如必须保留英文，至少统一为“事件 event”。
- 表单脏关闭确认不变。

#### 提示词

```
PageHeader   提示词 · 一份正文，所有 agent 共用
PageToolbar  单一源 ~/.agents/prompts/global.md · 1,234 字节
Content
┌ 单一源正文 [未保存] ───────────────────────┬ 链接目标 ─────────────┐
│ ~/.agents/prompts/global.md                │ Claude Code  已链接   │
│ ┌────────────────────────────────────────┐ │ [打开]                │
│ │ textarea                               │ │ Codex        副本 ≠   │
│ │                                        │ │ [对齐到源]            │
│ └────────────────────────────────────────┘ │ pi           缺失     │
│ 1,234 字节 · 有未保存的修改   [保存并生效] │ [对齐到源]            │
└────────────────────────────────────────────┴───────────────────────┘
```

关键改动：

- 编辑器与目标卡片并排；目标卡片只显示状态与一个动作。
- 保存条贴在编辑器卡片底部，不随页面滚动消失。
- 冲突 warning 固定在编辑器上方，保留“载入磁盘版本”按钮与文案。
- `#prompt-source-editor`、`.editor-card .tag`、`.editor-actions` 全部保留。

#### 设置

```
PageHeader   设置 · 编辑各 agent 的用户级配置
AgentSwitch  [● Claude Code 5 个文件] [● Codex 4] [● pi 3]
Toolbar      搜索 [模型…]                    □ 显示未设置项
┌ 内导航 200px ─┬ 内容 max 880px ─────────────────────────────────┐
│ 模型  3       │ ┌ 模型 ───────────────────────────────────────┐ │
│ 常用  8/20    │ │ 默认模型  [gw/alpha-large        ▾]          │ │
│ 权限  …       │ │ 说明文字……                                   │ │
│ MCP servers   │ └─────────────────────────────────────────────┘ │
│ 原始文件      │ ┌ 其它分组 …                                  │ │
│               │ └─────────────────────────────────────────────┘ │
└───────────────┴─────────────────────────────────────────────────┘
SaveBar       3 个文件有未保存修改              [放弃修改] [保存全部]
```

关键改动：

- agent 切换与内导航保持两层，但视觉语言统一为“分段控件 + 侧栏列表”；内导航 sticky。
- 内容列限宽 880px，字段不再横跨整屏。
- 保存条 sticky 在内容区底部（不是视口底部），窄屏也始终可见；保留 `.save-bar` 类名与“未保存”文案。
- 冲突消息集中在 `.settings-messages`，不再分散到各文件卡片。
- `.settings-nav .nav-item` 的 **第一个子节点必须是文本节点**（“模型”/“常用”），因为 ui-check 用 `firstChild.textContent.trim()` 定位（`ui-check.mjs:378-380`、`:472-474`）。若加图标，图标必须放在文本之后，或同步修改测试。

#### 缓存

```
PageHeader   缓存 · 清理会话记录与缓存，先进回收站
PageToolbar  合计 1.2 GB（4,231 个文件） · 回收站 80 MB（1 项）
             清理范围 [全部文件 ▾]                          [刷新]
┌ 位置 ───────────────┬ 占用 ────────┬ 最近写入 ┬ 操作 ┐
│ ▌Claude Code 3 个位置│ 820 MB      │          │ 清理本组│
│   会话记录            │ 400 MB · 12 │ 明天     │ 清理   │
│   缓存                │ 380 MB · …  │ 3 天前   │ 清理   │
│ ▌Codex 2 个位置       │ 300 MB      │          │ 清理本组│
└─────────────────────┴──────────────┴──────────┴────────┘
回收站 ▸ 1 项 · 80 MB                                  [清空回收站]
```

关键改动：

- 保留 `.toolbar select`（ui-check 通过它设置 30/0 天），只重排视觉。
- 组行作为分区标题，不做成可点击数据行；合计右对齐，数字用 tabular-nums。
- 回收站与快照面板在视觉上明确区分：回收站是缓存页内容，快照是全局操作历史。
- 空态保留现有文案“本机没有发现已知的缓存目录”。

### 3.7 交互与可访问性规范

- **焦点**：所有交互元素有 `:focus-visible` 环（`--ring`）；表格行内按钮不因 hover 消失。
- **导航语义**：把 `role="tablist"` 改为 `<nav aria-label="主导航">` + `<a href="#skills" aria-current="page">`，或保留按钮但实现方向键。推荐前者：hash 导航本来就是页面导航。
- **标题**：切换页签时 `document.title = `${activeTab.title} · AgentManager``；不新增页面，只同步。
- **实时区域**：notice 用 `role="status"`，error 用 `role="alert"`；确认框失败已有 `role="alert"`（`ConfirmDialog.tsx:73-77`）。
- **对比度**：所有正文 ≥4.5:1；`--text-dim` 只用于辅助信息，且不小于 11px。
- **键盘**：保留 `Ctrl+S` 的现有条件；不要在 Skills/MCP/Hooks 新增保存快捷键（它们没有草稿保存语义）。
- **表格**：每个表有 caption；排序/筛选状态通过 `aria-pressed` 与可见计数表达。
- **动效**：遵循 `prefers-reduced-motion`（`styles.css:4096-4104`）。

### 3.8 响应式规则

| 断点 | 布局 | 表格 | 表单 | 页头 |
| --- | --- | --- | --- | --- |
| ≥1180 | 侧栏 + 内容；提示词两栏；MCP 抽屉 | 全列 | 2 列 | 标题与动作同行 |
| 960–1179 | 侧栏 232px；提示词堆叠 | 全列，首列冻结 | 2 列 | 动作换行 |
| 680–959 | 顶栏导航；状态卡收起 | 首列冻结，横向滚动 | 1–2 列 | 标题/动作上下 |
| <680 | 单列；工具栏纵向 | 首列冻结，横向滚动 | 1 列 | 单列；保存条 sticky |

原则：断点只改变“怎么排”，不隐藏关键操作；表格在窄屏允许滚动，但不允许把状态列挤掉。

---

## 4. 实施计划

### 4.1 波次

| 波次 | 目标 | 文件 | 验收 |
| --- | --- | --- | --- |
| 0a | CSS 拆分，仅移动不改规则 | `web/src/styles.css` → `web/src/styles/{tokens,base,shell,components}.css` + `pages/*.css`；`web/src/main.tsx` 不变 | `npm run build`；`npm run verify:ui` 全绿；`npm run shots` 与改动前肉眼一致 |
| 0b | 新 token 值与新增字号/间距变量 | `styles/tokens.css` | 明暗两套截图；对比度抽查；`verify:ui` 全绿 |
| 0c | 机械格式化 Hooks / MCP 的压缩 JSX（不改行为） | `HooksView.tsx`、`McpView.tsx` | `typecheck`、`verify:ui` 全绿；diff 只含换行/缩进 |
| 1 | 外壳、导航分组、页头、状态卡、`document.title` | `App.tsx`、`styles/shell.css` | `verify:ui`（nav id、`.side-attention` 文案）；明暗截图 |
| 2 | 基础组件：对话框尺寸、ModelPicker、RawEditor、FieldEditor、McpEditor 视觉 | `ConfirmDialog.tsx`、`ModelPicker.tsx`、`RawEditor.tsx`、`FieldEditor.tsx`、`McpEditor.tsx`、`styles/components.css` | 模型选择器、label→trigger、对话框焦点/失败重试全部通过 |
| 3 | 矩阵页：Skills、MCP、Hooks 的 FilterBar / DataTable / 表单外壳 | `SkillsView.tsx`、`McpView.tsx`、`HooksView.tsx`、`styles/pages/{skills,mcp-hooks}.css` | Skills 筛选、Hooks 图例、MCP 函数表单与脏关闭全部通过 |
| 4 | 编辑类页：提示词、设置、缓存 | `PromptsView.tsx`、`SettingsView.tsx`、`CacheView.tsx`、`SnapshotsPanel.tsx`、`styles/pages/{prompts,settings,cache}.css` | `Ctrl+S` 三组用例、设置导航定位、缓存/回收站全流程通过 |
| 5 | 商店与商店对话框 | `StoreView.tsx`、`StoreDetailDialog.tsx`、`StoreMcpInstallDialog.tsx`、`styles/pages/store.css` | 商店搜索/翻页/预览/安装/三语切换全部通过 |
| 6 | 响应式与打磨 | `styles/responsive.css`、各页尾部 | 680/960/1180/1440 四档截图；`verify:ui` 全绿 |

### 4.2 共享文件的编辑顺序

必须串行，不能并行开分支：

1. `web/src/styles.css`（入口，只做 `@import` 或 token）
2. `web/src/styles/tokens.css`
3. `web/src/styles/components.css`（基础控件）
4. `web/src/components/ConfirmDialog.tsx`（先加 `data-size`，默认行为不变）
5. `web/src/App.tsx`（导航/页头/状态卡；**冻结所有 id 与 aria 属性**）
6. `web/src/components/ModelPicker.tsx`
7. `web/src/components/FieldEditor.tsx` → `web/src/components/McpEditor.tsx`
8. 页面：`SkillsView.tsx` → `McpView.tsx` → `HooksView.tsx` → `PromptsView.tsx` → `SettingsView.tsx` → `CacheView.tsx` → `StoreView.tsx`
9. 商店对话框：`StoreDetailDialog.tsx` → `StoreMcpInstallDialog.tsx`
10. `styles/responsive.css`（最后统一断点）

并行规则：

- Wave 0 之后，页面 CSS 文件相互独立，可以并行；但 `tokens.css`、`components.css`、`App.tsx`、`ConfirmDialog.tsx` 任何时刻只能有一个写者。
- 禁止在同一个 PR 里既改类名又改使用该类的页面；采用“双类过渡”：`className="mcpm-head page-toolbar"`，测试稳定后再删旧类。
- 每波结束必须跑 `npm run verify:ui`；不允许把失败留到下一波。

### 4.3 单文件 CSS 的拆分迁移

现状：`web/src/styles.css` 4104 行，按注释分区（tokens 7、Base 135、Shell 271、Controls 647、Messages 903、Cards 995、Tables 1081、Prompts 1301、Snapshots 1356、Cache 1417、Settings 1524、Models 2085、MCP/Hooks 2629、MCP editor 2976、Raw 3133、Save bar 3161、Confirm 3293、Store 3394、Responsive 3857）。

迁移方式（Wave 0a，单独提交）：

1. 按上述分区把整段规则剪切到新文件，**声明与顺序不变**。
2. `web/src/styles.css` 只保留按原顺序排列的 `@import './styles/…';`。Vite 会在构建时内联 CSS `@import`，`main.tsx` 的 `import './styles.css'` 不需要改。
3. 目标结构：
   ```
   web/src/styles.css
   web/src/styles/tokens.css
   web/src/styles/base.css
   web/src/styles/shell.css
   web/src/styles/components.css   /* controls, messages, cards, tables, dialogs */
   web/src/styles/pages/skills.css
   web/src/styles/pages/store.css
   web/src/styles/pages/mcp-hooks.css
   web/src/styles/pages/prompts.css
   web/src/styles/pages/settings.css
   web/src/styles/pages/cache.css
   web/src/styles/responsive.css
   ```
4. 验收：构建产物 CSS 总量变化 <1%；`shots` 前后逐页对比；`verify:ui` 全绿。因为只是剪切，不需要逐条比对声明。
5. 完成后再做 0b 的 token 值替换；此时 diff 只出现在 `tokens.css`，回归面清晰。

如果不想拆文件，最低要求是把 §3.4 的 token 加在 `styles.css` 顶部，并在每个波次末尾追加该波的规则段；但 4104 行会继续增长，长期不利于并行。

### 4.4 验收方式

每个波次统一执行：

```bash
npm run typecheck
npm test
npm run build
npm run verify:ui
npm run shots
```

- `verify:ui` 需要本机 Edge 或 Chrome（`scripts/ui-check.mjs:18-28`）；脚本临时起真实服务与假注册表，最后打印 `N/N checks passed` 并以退出码判定。
- `shots` 输出到 `.build/shots/`，默认窗口 1440×940（`scripts/shots.mjs:108`），覆盖 7 个页签的明暗两套（`scripts/shots.mjs:181`、`:199`）。
- 额外人工检查：960px 与 680px 宽度、键盘 Tab 顺序、`prefers-reduced-motion`、浅色下所有 10.5–12px 文本的对比度。

---

## 5. 兼容与风险

### 5.1 `scripts/ui-check.mjs` 的依赖（必须逐项保留）

这是重设计的“公共测试 API”。任何一项改名/改文案，都必须同步修改脚本，否则 `verify:ui` 失败。

#### 结构与选择器

| 选择器 | 用途 | 脚本位置 |
| --- | --- | --- |
| `#nav-<key>`（`nav-skills/prompts/settings/mcp/hooks/cache`） | 页签跳转 | `:328`、`:341`、`:366`、`:491`、`:755`、`:835`、`:871`、`:919`、`:970`、`:1056`、`:1096` |
| `[aria-controls="workspace-panel"][id="nav-prompts"]` | 提示词页签 | `:328` |
| `#prompt-source-editor` | 提示词 textarea | `:331`、`:557`、`:586`、`:668` |
| `document.querySelector('table')` / `table tbody tr` / `tbody th[scope="row"]` | Skills 矩阵 | `:320`、`:323`、`:699`、`:733`、`:743` |
| `td.cell button` | Skills 行内动作 | `:758` |
| `.cell` / `.cell-state`（间接） | 矩阵单元格 | `SkillsView` 现状 |
| `.editor-card .tag` | 保存状态 | `:339`、`:570` |
| `.editor-actions button` | “保存并生效” | `:624-628` |
| `.warning button` | “载入磁盘” | `:616`、`:656` |
| `.error` / `.warning` | 冲突提示 | `:599-616`、`:667-674` |
| `.notice` | 全局/页面通知 | `:571`、`:826`、`:1191`、`:1217`、`:1291`、`:1420` |
| `.confirm-dialog` / `.confirm-dialog-body` / `.confirm-dialog-error` / `.confirm-dialog-actions button` | 统一确认框 | 多处，见下 |
| `.settings-page` / `.models-panel` | 设置页根 | `:367`、`:920` |
| `.agent-tab`（≥3） | agent 切换 | `:370` |
| `.settings-nav .nav-item`（`firstChild.textContent.trim()` 为“模型”/“常用”） | 内导航 | `:378-380`、`:472-474`、`:922-924` |
| `.settings-tools input[type="search"]` | 设置搜索 | `:938` |
| `.field` / `.custom-keys` / `.save-bar` | 表单与外层 | `:929-934` |
| `.field-label` 的 `for` 指向 `.model-picker-trigger` | 可访问性 | `:949-967` |
| `.model-picker-trigger` / `-panel` / `-search` / `-option` / `-custom` / `-none` | 模型选择器 | `:386-447` |
| `.mcpm-page` / `.mcpm-head` / `.mcpm-head-actions button` | MCP 页头 | `:872`、`:874`、`:973` |
| `.mcpm-form` / `.mcpm-form-actions button` / `input[placeholder*="filesystem"]` | MCP 表单 | `:977-1031` |
| `.hook-page` / `.hook-form` / `.mcpm-head-actions`（Hooks 复用） | Hooks 页 | `:1057-1092` |
| `.toolbar select` | 缓存范围 | `:1097`、`:1112` |
| `table.cache-table` / `tbody.cache-group` / `.cache-group-row .cache-agent` / `.cache-group-row button` | 缓存表 | `:1130-1138`、`:1229-1232` |
| `.cache-clean-list code` | 组清理路径 | `:1239` |
| `.snapshots`（取最后一个） / `.snapshots .link-button` / `.snapshots header button` / `.snapshot-list li` / `li button` | 回收站与快照 | `:1194-1299`、`:1472-1485` |
| `.store-page` / `.store-card` / `.store-owner` / `.store-action` / `.store-targets .check` | 商店卡片 | `:1304-1322` |
| `.store-search` / `.store-search input` / `.store-search button[type=submit]` | 商店搜索 | `:1325-1333`、`:1440`、`:1456` |
| `.store-page .meta` | 搜索回显 | `:1332` |
| `.store-pager` / `.store-pager-label` | 分页 | `:1336-1364` |
| `.store-lang button`（索引 2 = 双语） | 语言 | `:1432`、`:1453` |
| `.store-targets-label` | 目标标签 | `:1441` |
| `dialog.store-detail-dialog` / `.store-detail-body` / `.store-detail-section h4` | 商店详情 | `:1367-1393` |
| `.side-attention` / `.side-attention button` / `.is-active` | 侧栏计数 | `:680-696` |
| `.legend-filter` / `.legend-clear` / `[aria-label="按 agent 筛选"]` | 图例筛选 | `:701-752` |
| `.hook-table tbody tr` | Hooks 表 | `:699` |

#### 必须逐字保留的文案

| 文案 | 位置/用途 | 脚本位置 |
| --- | --- | --- |
| `未保存` / `已保存` | `.editor-card .tag` | `:339`、`:575` |
| `切换页面` / `放弃并切换` | 脏导航确认 | `:344`、`:359`、`:520` |
| `放弃并载入` / `载入磁盘` | 提示词冲突 | `:616`、`:663` |
| `已被外部修改` / `别处修改` | 409 错误与 warning | `:609`、`:620` |
| `保存并生效` | 提示词保存 | `:626` |
| `取消` | 所有 danger 对话框焦点断言 | `:639`、`:859`、`:998`、`:1082`、`:1180`、`:1245`、`:1283`、`:1497` |
| `重试` | 确认框失败后按钮 | `:819` |
| `建立链接` / `收进源` / `删除副本` / `移除链接` | Skills 确认动作 | `:799`、`:893`、`CONFIRM` |
| `放弃并关闭` | MCP/Hooks 表单守卫 | `:1026`、`:1087` |
| `新增 server` / `新增事件` | 页头按钮 | `:974`、`:1036`、`:1060` |
| `从现有配置导入` | MCP/Hooks 导入 | `:874`、`:1059` |
| `显示全部 N 行`（此处为 `显示全部 2 行`） | 筛选清除 | `:721` |
| `清理` / `清理本组` / `移到回收站` | 缓存动作 | `:1161`、`:1188`、`:1231` |
| `清理缓存` / `清空回收站`（对话框标题） | 缓存/回收站 | `:1179`、`:1283` |
| `清空并释放空间` | 永久删除 | `:1288` |
| `已彻底删除` / `已恢复` / `已安装 latte` / `快照` | 成功通知 | `:1291`、`:1217`、`:1420`、`:829` |
| `还原到这个快照` | 快照还原标题 | `:1497` |
| `恢复` | 回收站恢复 | `:1206`、`:1214` |
| `源里已有 In source` / `In source` | `.store-action` 精确文本 | `:1427`、`:1436` |
| `Search` / `Link to` / `搜索 Search` | 商店英文/双语 | `:1440-1458` |
| `第 1 / 3 页` / `第 2 / 4 页` | 分页标签 | `:1342-1364` |
| `Order a latte` / `能做什么` / `限制` | 商店详情 | `:1368-1385` |
| `Skills 2` / `Hooks 2` | 侧栏计数 | `:688` |
| `模型` / `常用` | 设置内导航首文本节点 | `:380`、`:474`、`:924` |
| `占用` / `30 天前` / `17 B` / `1 个文件` / `3 个文件` / `本机没有发现已知的缓存目录` | 缓存表 | `:1124-1156`、`:1256`、`:1262` |
| `链接` | Skills 行状态 | `:1466` |
| `acme/acme-latte` | 商店 owner | `:1317`、`:1411` |
| `Claude Code` / `Codex` | 安装确认 | `:1409-1410` |

#### 行为契约（不能改）

- 原生 `<dialog>`：`showModal()`、`open` 属性、`cancel` 事件、遮罩点击取消（`ConfirmDialog.tsx:38-69`）。
- danger 对话框初始焦点在“取消”（`:43`）。
- 写操作在 `run` 内执行，失败显示 `.confirm-dialog-error` 并保留框，按钮变“重试”（`:73-90`）。
- 全局 `isConfirmOpen()` 计数，确认框打开时 `Ctrl+S` 不保存（`web/src/lib/confirm.tsx`、`PromptsView.tsx:76`、`SettingsView.tsx:386`）。
- 不使用 `window.confirm` / `window.alert`（ui-check `:535-579` 会统计调用次数）。
- 页面不得产生任何 console error（ui-check `:1467-1468`；React key 警告也会计入）。
- 商店语言切换后，`.store-action` 的 textContent 必须精确为 `In source`，双语为 `搜索 Search`。
- `.settings-nav .nav-item` 的首个子节点必须是文本节点（不是 `<span>`）；否则 `firstChild.textContent.trim()` 取不到“模型”。
- `.store-pager-label` 的文本以“第 1 / 3 页”开头；MCP 分页不得伪造总页数。

### 5.2 必须保留的产品不变量

来自 `architecture.md:53-62`，重设计不得触碰：

- 写路径先快照；每个写操作可还原。
- 前端不推导状态，格子显示后端 `state`。
- 确认文案必须写明具体路径；删除类默认焦点“取消”。
- 缓存清理是移动到回收站，只有“清空回收站”不可逆。
- 商店只写源目录与 `data/tmp/`；不覆盖同名条目；不执行 skill 内容、不启动 MCP server。
- 提示词保存的 etag 乐观锁与 409 处理不变。
- API 只监听 `127.0.0.1`；前端不改协议。

### 5.3 风险与缓解

| 风险 | 概率/影响 | 缓解 |
| --- | --- | --- |
| ui-check 选择器/文案被改坏 | 高/高 | §5.1 清单作为评审车门；每波跑 `verify:ui`；改名采用双类过渡 |
| CSS 拆分改变级联顺序 | 中/高 | Wave 0a 只剪切不修改；`@import` 顺序与原分区一致；shots 对比 |
| 明暗两套 token 漂移 | 中/高 | 只允许三处赋值；新增颜色先加变量；对比度脚本/人工抽查 |
| 设置页重构引入逻辑回归 | 中/高 | 先机械格式化；再纯展示层替换；`Ctrl+S`、409、保存顺序用例必须全绿 |
| 表格降密度导致可读性下降 | 中/中 | 12.5px 下限、40px 行、对比度 ≥4.5；窄屏冻结首列 |
| 对话框尺寸变体影响焦点/关闭 | 低/高 | 默认保持 sm 480px 与现有焦点逻辑；尺寸只加 `data-size` |
| 商店三语文案被“优化” | 中/中 | 不改 `STORE_TEXT` 键与值；只改布局；保留 `.store-*` 类名 |
| 引入外部字体（方向 B） | —/中 | 不推荐 B；若选 B，字体必须本地打包并评估体积，不能依赖网络 |
| 并行开发互相覆盖 `styles.css` | 高/中 | Wave 0 拆文件；共享文件单写者；页面 CSS 独立 |

### 5.4 完成标准

一个波次只有同时满足以下条件才算完成：

1. `npm run typecheck` 通过。
2. `npm test` 通过。
3. `npm run build` 通过。
4. `npm run build && npm run verify:ui` 打印 `N/N checks passed` 且退出码 0。
5. `npm run shots` 生成 7 页 × 明暗截图，人工核对无布局断裂、无文本截断、无对比度不足。
6. `git diff` 只包含该波次声明的文件；没有新增依赖、没有后端/共享类型改动。
7. 没有新增 `window.confirm` / `alert`；没有内联样式；没有 utility 类。

---

## 附录 A：关键文件与行号索引

| 主题 | 位置 |
| --- | --- |
| 页签定义与文案 | `web/src/App.tsx:41-84` |
| 导航渲染 | `web/src/App.tsx:370-391` |
| 侧栏状态与需处理 | `web/src/App.tsx:393-449` |
| 页头 | `web/src/App.tsx:463-487` |
| 工作区与视图挂载 | `web/src/App.tsx:489-523` |
| 脏导航保护 | `web/src/App.tsx:197-221` |
| 重新扫描 | `web/src/App.tsx:284-299` |
| 退出 | `web/src/App.tsx:329-350` |
| 颜色 token | `web/src/styles/tokens.css` |
| 侧栏布局 | `web/src/styles/shell.css` |
| 页头样式 | `web/src/styles/shell.css` |
| 表格样式 | `web/src/styles/tables.css` |
| 确认框样式 | `web/src/styles/dialogs.css` |
| 响应式 | `web/src/styles/responsive.css` |
| Skills 视图 | `web/src/views/SkillsView.tsx:218-357` |
| 商店视图 | `web/src/views/StoreView.tsx:313-372`、`:484`、`:639-663` |
| MCP 视图 | `web/src/views/McpView.tsx:453-467`、`:547`、`:699-850` |
| Hooks 视图 | `web/src/views/HooksView.tsx:165-194`、`:276` |
| 提示词视图 | `web/src/views/PromptsView.tsx:294-393` |
| 设置视图 | `web/src/views/SettingsView.tsx:1577-1653`、`:1763`、`:381-392` |
| 缓存视图 | `web/src/views/CacheView.tsx:310-359`、`:464` |
| 确认框组件 | `web/src/components/ConfirmDialog.tsx:38-93` |
| 商店详情弹窗 | `web/src/components/StoreDetailDialog.tsx:315-373` |
| UI 断言 | `scripts/ui-check.mjs`（全文） |
| 截图脚本 | `scripts/shots.mjs:108`、`:181`、`:199` |
| 架构约束 | `architecture.md:42-62` |
| 使用说明 | `README.md:18-54`、`:94-102` |

## 附录 B：文案改写示例

原则：中文为主；领域词首次出现给中英对照，之后统一；页头说明描述“能做什么”，不描述实现。

| 位置 | 现状 | 建议 |
| --- | --- | --- |
| 商店 lede（`App.tsx:52`） | 从 skillstore.io 搜索技能、从官方 MCP Registry 搜索 MCP server，装进各自的源目录，再链接或同步给 Claude Code、Codex 与 pi。Skills come from skillstore.io; MCP servers come from the official MCP Registry. | 搜索并安装 skill 与 MCP server，再链接或同步到三个 agent。 |
| Skills lede（`App.tsx:46`） | 查看每个 skill 在 Claude Code、Codex、pi 中的链接状态。 | 查看每个 skill 在三个 agent 中的链接状态。 |
| MCP lede（`App.tsx:58`） | 统一维护 MCP server 源，并同步到 Claude Code、Codex 与 pi。 | 维护一份 MCP 定义，同步到三个 agent。 |
| Hooks lede（`App.tsx:64`） | 统一维护生命周期 hooks 源，并同步到 Claude Code 与 Codex。 | 维护一份 hooks 事件源，同步到 Claude Code 与 Codex。 |
| 设置 lede（`App.tsx:76`） | 编辑各 agent 的用户级配置与 MCP。 | 编辑每个 agent 的用户级配置。 |
| 缓存 lede（`App.tsx:82`） | 查看各 agent 的会话记录与缓存占用，清理后先从回收站里保留，可随时恢复。 | 查看缓存占用；清理先进回收站，可恢复。 |
| 新增 MCP | 新增 server | 新增 MCP server |
| Hooks 表头 | `event` | 事件 |
| 需处理 | 需处理：Skills 2 · Hooks 2 | 需处理（保留 `Skills 2` / `Hooks 2` 按钮文本） |

注意：表中所列“现状”只要被 ui-check 断言（如 `Skills 2`、`Hooks 2`、`未保存`、`已保存`、`显示全部 2 行`），就不能直接改；文案优化必须与脚本更新同一提交。

## 附录 C：实施记录（2026-11-02）

- **共享层**：`web/src/styles/tokens.css` 重建字号/间距/行高/控件/层级 token；`shell.css` 落地深石墨侧栏、三组导航、页面 eyebrow 与 42px 行高内容区；`components.css`、`tables.css`、`dialogs.css`、`save-bar.css` 统一按钮与控件高度、冻结首列表格、`data-size` 对话框与粘性保存条。
- **CSS 拆分**：`web/src/styles.css` 只保留按原级联顺序的 `@import`，各页面样式归入 `web/src/styles/pages/*.css`，页面可以独立演进而不互相覆盖。
- **页面**：Skills / MCP / Hooks（矩阵页）、提示词 / 缓存 / 快照（编辑页）、设置（表单页）、商店与两个安装/预览弹窗四组并行落地；`App.tsx` 的导航顺序改为 Skills、商店、提示词、MCP、Hooks、缓存、设置，并按「管理资产 / 单一源 / 本机维护」分组。
- **响应式**：≤960 侧栏折叠为顶栏；≤680 顶栏压成两行（隐藏状态明细，保留需处理入口与退出）、设置分区导航改横向滚动、商店搜索改为「目录 + 热门 / 搜索框 + 搜索」两行网格、提示词目标单列、缓存数字不换行。
- **兼容**：`scripts/ui-check.mjs` 依赖的类名、精确文案、确认流程、`Ctrl+S`、模型选择器键盘行为全部保留；70 项检查连续两次通过。
- **验证**：`npm run typecheck`、`npm test`（196/196）、`npm run build`、`npm run verify:ui`（70/70）、`npm run shots`（明暗各 12 张 + 手机 5 张）通过。
- **截图脚本**：`scripts/shots.mjs` 增加商店工具区、商店详情预览和 390px 视口三组画面，便于后续回归时肉眼核对。

## 附录 D：收敛为本地开发工具（2026-11-02）

首版重设计的视觉偏“产品官网”：暖白大圆角卡片、彩色胶囊标签、蓝色实心安装按钮、卡片阴影与全大写小标题。实机截图后确认 AI 味来自这些装饰性信号，于是整体收敛，功能与交互不变：

- **配色**：亮色改为中性暖灰 `#f2f2ee` 画布 + 白表面，文字 `#1b1b16` / `#4d4d45` / `#6d6d63`；蓝色只保留一个克制强调色 `#1a5fb4`（深色 `#8fb4e8`）。深色主题同步改为中性墨黑，不再偏蓝。
- **几何**：圆角收到 3–8px；卡片、面板、表格、输入框一律 1px 边框；静态表面去掉阴影，只有对话框、浮层、保存条保留抬起阴影。
- **动作层级**：新增 `--primary-bg/text` token，每页只允许一个深色实心主按钮（深色主题反转为浅色实心）；商店安装、表格行内操作、图例筛选等全部改为描边次级按钮或纯文字。危险操作仍用红色，但确认框之外不再铺彩色底。
- **状态表达**：标签、徽章、风险级别、模型能力、MCP 状态改为透明底 + 细描边 + 语义色文字；提示条改为白底 + 左侧色线，不再用粉/黄/绿色块。
- **排版**：去掉全大写与加宽字距的小标题（eyebrow、分组标签、表头、商店字段标题），改为正常大小写、中等字重、中性灰；侧栏激活项用 2px 内阴影左线而非整块高亮。
- **商店**：默认语言改为中文（`store-i18n.ts` 无存储值时返回 `zh`），切换 English / 双语仍然保留；`scripts/ui-check.mjs` 的默认语言断言同步改为中文安装动作，其余英文/双语断言不变。
- **清理**：移除这次改动产生的孤儿 token（`--accent-soft`、`--info-soft`、`--tracking-caps`、`--shadow-xs`、`--shadow-sm`）及全部 `box-shadow: var(--shadow-xs/sm)` 空操作声明。
- **验证**：`npm run typecheck`、`npm test`（196/196）、`npm run build`、`npm run verify:ui`（70/70）、`npm run shots`（29 张）通过；release exe 重新构建后按新 UI 运行。

## 附录 E：第三轮收敛——去掉“生成感”并修好深色主题（2026-11-02）

用户反馈仍“很像 AI 做的”，并且深色模式下会看到一大块白色。逐页截图 + 浏览器实扫（CDP 遍历所有元素背景，未发现 >4000px² 的浅色块）后判断，白色最可能来自**反色主按钮**：附录 D 把深色主按钮做成 `#e9e9e1` 浅色实心，在深色页面上就是一块刺眼的白。现在主按钮在明暗两套都是蓝色实心（`--primary-bg: #2f6feb`），不再反色；同时补了首帧主题脚本，排除启动闪白。

- **侧栏**：与页面同一块底色（`--sidebar-bg` 跟随主题的 `--bg`），只用 1px 右边界线分隔；导航项 32px 高、12.5px 常规字重、激活为整行浅底 + 15px 图标着色，不再用内阴影左线，也不再是独立深色面板。侧栏加宽到 244px，状态行不再折行。
- **配色**：亮色改为中性冷灰 `#f3f4f6` 画布 / 白表面 / `#dcdfe3` 边线，文字 `#191b1f` / `#4b5158` / `#6d747c`；蓝色 `#1f6feb` 是唯一强调色。深色为 `#101214` 画布 / `#17191c` 表面 / `#2b2f34` 边线，文字 `#e6e8eb` / `#aeb4bb` / `#858c94`，强调色提亮为 `#6ea8fe`。
- **几何**：圆角收到 2–6px，控件 32px、行高 38px、标签 18px；去掉所有静态阴影与彩色底标签，状态只用文字颜色或左侧细线。
- **页头**：删除 eyebrow，页头 56px：19px 标题 + 单行说明，右侧主题切换改为无边框文字按钮。
- **商店**：卡片网格改成**一张带边框的单列条目表**——左侧名称/owner，第二列分类 · 风险 · 质量纯文字，中间摘要单行截断，右侧更新时间与 26px 的「安装」按钮；已安装行用 2px 绿色左线标记。分类/风险/质量/联网/脚本不再是一个个胶囊，而是同一行灰字。目录与语言开关也从分段控件改为纯文字，选中项只加粗。
- **排版密度**：表头 32px、单元格 6px 内边距、控件 12px 字号、标签 10px；工具区、页头、侧栏一起收紧。
- **深色首帧**：`web/index.html` 增加 `color-scheme` meta 和首帧前读取 `agentmanager.theme` 的内联脚本，深色窗口启动不再闪白。
- **兼容**：类名、文案、`Ctrl+S`、确认流程全部不变；`verify:ui` 70/70、`npm test` 196/196。`npm run shots` 重新生成 29 张，确认深色无浅色大块（脚本另扫过全部弹窗与页面，最大浅色块为空）。

## 附录 F：体验修订（2026-11-02）

UX 走查后的第一批修正，不涉及后端与协议：

- **安装后的下一步**：skill 安装成功的通知里加「去 Skills 查看」（英文 Check in Skills），点击切到 Skills 页核对链接；MCP 安装不加，因为它是就地同步。`scripts/ui-check.mjs` 增加两项断言（通知链接文案 + 真的切到 Skills 页），检查数从 70 变为 72。
- **空态不再重复动作**：Hooks / MCP 的空态原本把页头已有的「新增 / 从现有配置导入」又渲染一遍；现在空态只保留说明，动作只在页头出现一次。
- **未保存草稿时降级「重新扫描」**：`App.tsx` 用 `draftDirty` 状态镜像提示词/设置的脏标记；有草稿时按钮改为描边次级，主行动留给保存条，重新扫描原有的「放弃并重新扫描」确认不变。
- **计数语义**：侧栏导航徽标的 `title` 写明「N 项需处理」，底部需处理列表的按钮补 `aria-label`（如「Skills：2 项需处理」）；设置内导航的「3/9」补 `title` / `aria-label`「已设置 3 项，共 9 项」。
- **已安装条目不渲染禁用按钮**：商店里已装的行改用 `<span class="store-action is-installed">源里已有</span>`，保留文案与 `.store-action` 选择器，但不再每行出现一个禁用的按钮控件。
- **手机导航跟随**：切页时把 `[aria-selected="true"]` 滚进侧栏/顶栏的可视区，横向滚动时当前页不会留在屏幕外。
- **验证**：`npm run typecheck`、`npm test`（196/196）、`npm run build`、`npm run verify:ui`（72/72）、`npm run shots`（29 张）。



## 附录 G：墨与纸重设计（2026-11-12）

用户选择「墨与纸 · 档案室」方向，并把外壳、视觉系统和页面语法一起重做。功能、API、确认流程与选择器契约不变。

- **身份**：暖纸画布 + 墨色文字 + 印章红强调；页面/区块标题用系统 UI 半粗体（Segoe UI Variable Display / 微软雅黑），品牌字标保留衬线，正文 Segoe UI Variable，路径与计数 Cascadia Mono；不使用网络字体。
- **外壳**：224px 文字索引侧栏（品牌印章、三组文字导航、底部「需处理」登记）；页面头去掉白色横条，改为纸面半粗标题 + 一行说明 + 描边「重新扫描」；30px 底部状态条承载三个 agent 的检测色块、提示词/MCP 摘要、主题、版本与退出。主题切换从页头移到状态条。
- **导航**：去掉线框图标，按用户要求不加编号；激活项用纸面底色 + 2px 左侧印章红；移动端折为可换行的文字导航。
- **色板**：亮色 `#f3efe5` 纸 / `#fbf8f1` 页 / `#201d17` 墨 / `#a3382a` 印章红；深色按反馈压到近黑 `#0d0b09` 纸 / `#14110d` 页 / `#f3ecdf` 墨 / `#ea8d77` 印章红，并提亮次级墨与界线，换取更清楚的对比。Agent 身份色只用于 6px 方点与列头标记：Claude Code 陶土、Codex 苔绿、pi 石板蓝。状态语义色保留 success / warning / danger / info。
- **几何与字号**：圆角 1–4px；静态表面无阴影；对话框、浮层、保存条保留抬起阴影；表格行高 42px，表头 30px，列间细线，首列冻结；控件 32px、正文 13.5px、行高 1.6；单元格动作改为墨色下划线文字，悬停转印章红，避免矩阵里铺满红按钮。
- **页面**：商店改为带上下界线的目录（内置技能独立一栏）；提示词编辑器改为纸面正文；设置页 agent 切换改为底部红线索引页签，设置内导航激活项用左侧红线/横向底红线；缓存按 agent 颜色分组；空态改为左对齐的简短说明，空矩阵不再渲染整行禁用图例。
- **skills 删除**：源里的每个 skill 在第一列多一个「删除」入口；确认框列出源路径、会一并移除的链接，以及会保留的独立副本/外部链接；服务端先快照再删源和指向它的链接，独立副本与指向别处的链接不动。快照面板可整体还原。
- **修复**：商店预览弹窗头部的 `.store-badges` 继承 `flex-basis` 导致 224px 高的空白，已改为 `flex: 0 0 auto`；移动端页头改为标题与「重新扫描」同排，减少纵向占用。
- **验证**：`npm run typecheck`、`npm test`（206/206，含删除源与快照还原）、`npm run build`、`npm run verify:ui`（80/80，含删除确认与取消）、`npm run shots`（明暗各 12 张 + 手机 5 张）、`npm run build:exe` 与 `npm run verify:exe`（内嵌 UI 正常）。


## 附录 H：商店与设置页重设计（2026-11-12）

在这两页上把「工具区 + 表格」进一步改成各自的工作形态，功能与选择器契约不变。

- **商店是目录桌**：左侧 208px 目录栏放 `Skills / MCP` 索引、安装后链接到的 agent（勾选框按 agent 色）、语言与注册表来源；右侧是搜索、结果元信息、内置技能书架与注册表目录。内置技能从普通行改成带底色的双列书架，注册表行保持单列。来源与端点从结果元信息移进左栏，元信息只留当前列表状态与条数。
- **商店响应式**：≤1100px 目录栏折成横向筛选区；≤680px 变成两列（目录 + 语言并排、安装目标独占一行），隐藏重复的来源块；搜索变成「输入框 + 搜索 / 热门」两行。
- **设置是文件页**：agent 页签下方新增文件状态条，每一行写清「agent · 文件角色、路径、字节数 / 解析失败」；左索引去掉外框，改成右侧细线分隔的索引，MCP servers 与原始文件之前加分隔线；搜索与「显示未设置项」改成一条粘性筛选线，不再套卡片。
- **双列字段**：每个字段变成「字段名 / 状态 / 清除」左列 +「控件 + 说明」右列，嵌套对象沿用同一语言；≤760px 回到单列。面板去掉卡片边框，用区块标题的强线分隔；面板头的文件路径改用 `compactPath`，完整路径留在 title 里。
- **验证**：`npm run typecheck`、`npm test`（206/206）、`npm run verify:ui`（80/80）、`npm run shots`（明暗与 390px）通过；`ui-check.mjs` 的模型选择器增加等待端点模型的断言，避免面板先挂载、列表后到达的时序抖动。

## 附录 I：模型 Provider（2026-11-12）

把模型来源从设置页里的「本地端点 + URL 输入」改成独立的 provider 选择。

- **Provider 页**：主导航「单一源」下新增 Provider。左侧是 provider 列表（host、base URL、当前/切换），右侧是 base URL + API key 表单与模型清单。新增 provider 只要求这两项；保存后自动成为 active 并读取 `<base URL>/models`。
- **密钥边界**：provider 文件是 `~/.agents/providers.json`，key 只在服务端请求模型时使用；`GET /api/providers` 只返回 `hasApiKey`，页面不回显已保存的 key，编辑时留空表示保留。写入走写队列并先建快照。
- **模型**：Provider 页显示 active provider 的模型清单（ID/名称、分组、上下文、输出、推理强度、能力），支持筛选、刷新、缓存/失败状态；模型缓存身份是 provider id + updatedAt，修改 key 或 URL 后自动失效。
- **设置页**：删除「模型」导航项、per-agent 模型卡片、模型源输入与模型清单；agent 的 model 字段继续存在，候选来自 active provider。设置页挂载或重新扫描时重新读取 provider 模型。
- **兼容清理**：移除 `GET /api/models` 旧路由和 `api.models` 客户端方法；`server/models.ts` 保留为纯读取/归一化模块，供 provider 使用。`AGENT_MANAGER_MODELS_URL` 不再参与页面行为。
- **测试**：`server/providers.test.ts` 覆盖保存/激活/删除、key 不回传、Bearer 请求、空 provider、损坏文件与快照还原；`ui-check.mjs` 增加从零创建 provider、读取 3 个模型、key 不回显的检查，并把模型选择器测试改为使用设置页「常用」里的 model 字段。`npm test` 213/213、`verify:ui` 84/84（含 provider 表单的未保存切换确认）、`shots` 增加 Provider 明暗与手机截图。
