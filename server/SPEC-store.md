---
id: module-store
type: module-design
status: active
title: 商店：从 skillstore.io 与官方 MCP Registry 搜索并安装
parent: architecture
---

## Responsibility

`server/store.ts` 把两个外部注册表的目录读成页面能渲染的清单：skill 来自 skillstore.io，MCP server 来自官方 MCP Registry。选中的 skill 下载、校验后装进唯一源目录 `~/.agents/skills`（`server/zip.ts` 是它依赖的最小 ZIP 读取器）；选中的 MCP server 写入 `~/.agents/mcp/servers.json`，再由 `server/mcp.ts` 同步给指定 agent。

## Boundary

**读 skill 目录**：`GET /api/store?q=&page=&limit=`（`refresh=1` 跳过缓存）。

- 查询为空 → `GET <base>/api/skills?limit=N&page=P`（注册表自己的排序）；有查询 → 同一路径加 `&q=…`。注册表用 `pagination.totalPages` 告诉源页数，报告里带 `page / limit / total / totalPages`，页面据此渲染「上一页 / 下一页」。
- 每行映射成：`id`/`slug`、`owner`（`author` 或 `githubUsername`）、`name`（`displayName`，装成目录就用它）、`summary`（`description`，回退 `aiDescription`）、`category`、`risk`（`safe/medium/high/critical`）、`license`、`repository`、`quality`（`qualityScore`）、`hasScripts`、`needsNetwork`、`downloads`/`favorites`、`version`、`updatedAt`。缺 `slug` 的行丢弃。
- 注册表按描述做模糊匹配，会把名字无关的包排在前面，所以结果在服务端重排一次：名字全等 > 名字前缀 > 名字包含 > slug 包含 > 其余，同档保持注册表顺序。
- 内存缓存 60 秒、最多 24 条；注册表失败时返回上次成功的清单并标 `stale` + `error`，没有缓存则返回空清单与错误。超时 20 秒，5xx 重试 3 次。
- 注册表地址可用 `AGENT_MANAGER_STORE_URL` 覆盖（必须 http/https），指向任何实现同样三个接口的镜像即可。

**读 skill 详情**：`GET /api/store/skill?slug=<slug>`。清单行只有一行摘要，点开卡片时才取 `<base>/api/skills/<slug>` 的完整记录：完整描述、`summary`、`aiContent`（`user_title` / `value_statement` / `actual_capabilities` / `limitations` / `use_cases`）、`fileStructure`、`securityAudit.summary`、`riskFactors`、`stats.viewCount`，映射成 `StoreSkillDetail`。slug 经与安装相同的白名单校验（不合法 400），响应认不出 502；`inSource` 与清单用同一套目录名 / slug 判断。MCP server 的详情直接用清单行渲染（`options` 已完整），不再发额外请求。

**装 skill**：`POST /api/store/install`，请求体 `{ owner, slug, name?, agents? }`。

1. 先解析 `agents`：未知 agent 立刻 400，不发起任何网络请求。
2. 读 `GET <base>/api/skills/<slug>/manifest`：`skill.name` 是目录名（不是 slug），`artifact.url` 是 ZIP 地址，`artifact.sha256` 是校验值。
3. 目录名校验：只允许 `[A-Za-z0-9][A-Za-z0-9._-]*`，拒绝 `..`、路径分隔符和 Windows 保留名。目标 `~/.agents/skills/<name>` 已存在 → 409，**不覆盖**（删副本、改名是 Skills 页的决定）。
4. 下 ZIP：上限 20MB；校验本地文件头 `PK\x03\x04`（限流/代理可能回 200 + HTML）；有 `sha256` 时比对，不一致直接 502。
5. 解压前先在 `<dataDir>/tmp/store-*` 里落地：只读中央目录（归档用数据描述符，局部头里的尺寸是 0），支持 store / deflate，拒绝 ZIP64 与异常压缩方式；单项 8MB、总计 40MB、最多 1000 项。
6. 路径安全：绝对路径、盘符、`..` 段一律 400；全部条目共用一个顶层目录时剥掉它，所以「包一层」和「平铺」两种打包都能落到 `<skill>/SKILL.md`。
7. 校验存在 `SKILL.md`，否则 400；临时目录在 `finally` 里删掉，源目录里不留半个 skill。
8. 建快照（`created` = 源目标 + 每个要建的链接），再把临时目录 `move` 进源（跨卷退化为复制+删除）。链接用 junction；目标已有同名条目则记为 `skipped` 并保持原样。链接失败（非同名占用，例如未开开发者模式时的 EPERM）说明环境本身建不了链接，若放任不管，skill 会留在源里而所有 agent 都显示「缺失」：此时撤掉本次已建的链接与源里的目录，把快照标记为失败并返回 500「已撤销本次安装」，让用户修好环境后重装。
9. 返回 `message / name / path / files / bytes / snapshotId / links[] / warnings[]` + 重扫的矩阵。还原这个快照会删掉新目录和它建的链接。

**读 MCP 目录**：`GET /api/store?kind=mcp&q=&cursor=&limit=`（`refresh=1` 跳过缓存）。

- 官方注册表只有 `GET <base>/v0/servers?limit=N&version=latest&search=…&cursor=…`：`search` 按名称子串匹配且**至少 3 个字符**（更短直接返回空清单 + 错误，不发请求）；没有 `total`，用 `metadata.nextCursor` 翻页，所以报告带 `nextCursor`、`total` 恒为 0，页面自己保存游标栈来渲染「上一页」。
- 每行 `{ server, _meta }` 映射成：`id`（反向域名）、`name`（`title`，回退名字尾段）、`owner`（命名空间）、`installName`（尾段清洗成 JSON key）、`summary`、`version`、`repository`、`websiteUrl`、`updatedAt`；`_meta.status === 'deleted'` 的行丢弃。
- 安装方式 `options` 来自 `packages` 与 `remotes`：
  - `npm` → `npx -y <id>@<version>`；`pypi` → `uvx <id>==<version>`；`oci` → `docker run -i --rm <runtime args> <image>`。`runtimeHint` 覆盖 runner。`mcpb`/`nuget`/`cargo`，以及 `transport.type` 不是 stdio 的包（需要另起服务）不生成选项。
  - `remotes` 的 `streamable-http`/`http` → `http`，`sse` → `sse`；URL 里 `{name}` 先填 `variables` 的默认值。
  - 输入分成两类：`default`/`value` 已知的直接写进 `env`/`headers`；`isRequired` 且没有默认值的留给安装弹窗（`variables[]`，`target` 为 `env` / `header` / `url`），`isSecret` 用密码框。可选且无默认值的直接省略。
  - 值本身也可能是模板（如 `Authorization: Bearer {api_key}`）：注册表声明且带默认值的占位符先填掉，剩下的 `{token}` 变成 `target: 'template'` 的弹窗变量，安装时替换定义里所有出现处；可选输入里的未声明占位符则整个省略，避免写进一个占位符字面值。
  - 必填参数没有值、或 URL 含注册表未声明的占位符时，整个选项丢弃，避免给出跑不起来的配置。
- 缓存与 skill 目录共用 60 秒 / 24 条的窗口；失败时返回上一页并标 `stale`。地址可用 `AGENT_MANAGER_MCP_STORE_URL` 覆盖（任何实现同一 `/v0/servers` 的镜像）。

**装 MCP server**：`POST /api/store/install-mcp`，请求体 `{ name, server, agents? }`。

1. 名称经 `validateServerName`（非空、≤100、无路径分隔符、拒绝原型链关键字），定义经 `normalizeDefinition` 校验。
2. `~/.agents/mcp/servers.json` 已有同名 key → 409，**不覆盖**（替换定义是 MCP 页的决定）。
3. 交给 `runMcpAction({ action: 'saveSource' })`：先给源文件建快照，再逐个 agent 文件建快照并写入；不支持 sse 的 agent 记 warning 后跳过。返回 `message / name / snapshotIds / warnings / report`，整次安装可由快照面板还原。

**双语显示**：`web/src/lib/store-i18n.ts` 保存商店页所有文案的中英两版，`StoreView` 用 `中文 / English / 双语`（默认双语，存 localStorage）渲染。只翻译界面词汇（按钮、状态、分类、风险级别、提示与确认框），**不翻译** skill/MCP server 自己的名字、描述与许可证——那是发布者的原文，机器翻译会与真实内容产生偏差。

**不做**：升级/版本固定/降级、发布 skill 或 MCP server、把安装结果记在源目录之外、执行 skill 里的任何东西、运行 MCP server、翻译发布者正文。

## 已知限制

- 「源里已有」按目录名（manifest 的 `name`）或 slug 判断：不同发布者的同名 skill 也会显示为已有，点不了安装。MCP 同理，按 `installName` 判断；弹窗里改名可以绕开。
- 没有更新检查：注册表上的新版本不会提示，重新安装需要先移除旧条目。
- 注册表是外部服务：它挂掉时页面只能给出缓存与错误，不能离线安装。
- 分类与风险级别的中文是内置词表（12 个分类），注册表新增分类会直接显示英文 slug。
- MCP Registry 没有总数，页面只能显示「第 N 页」，不能显示「共 M 页」；搜索也只匹配名称，不匹配描述。

## Why

`~/.agents/skills` 是唯一源、agent 侧只有链接——安装因此只需写一处；把下载、校验、解压放在源目录之外的临时目录，再一次性 `move`，可以让失败不留下任何被扫描到的半成品。ZIP 读取器不引依赖，是因为只服务一个接口、只处理两种压缩方式，而任何第三方解压库都要额外处理同样的路径穿越与 zip bomb 风险。MCP 走「写源 + 同步」，因为 agent 的 MCP 配置是各自的 JSON/TOML 副本而不是链接，`runMcpAction` 已经负责快照与格式差异，商店只负责把注册表条目翻译成中立的 `McpServerDefinition`。双语词典放在前端而不是服务端，是因为它只影响渲染，服务端返回值保持单份事实。
