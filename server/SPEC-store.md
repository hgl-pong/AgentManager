---
id: module-store
type: module-design
status: active
title: 技能商店：从 skillstore.io 搜索并安装 skill
parent: architecture
---

## Responsibility

`server/store.ts` 把外部技能注册表的目录读成页面能渲染的 `StoreSkill[]`，并把选中的 skill 下载、校验后装进唯一源目录 `~/.agents/skills`；`server/zip.ts` 是它依赖的最小 ZIP 读取器。装完可以按请求把新 skill 链接到指定 agent。

## Boundary

**读目录**：`GET /api/store?q=&page=&limit=`（`refresh=1` 跳过缓存）。

- 查询为空 → `GET <base>/api/skills?limit=N&page=P`（注册表自己的排序）；有查询 → 同一路径加 `&q=…`。注册表用 `pagination.totalPages` 告诉源页数，报告里带 `page / limit / total / totalPages`，页面据此渲染「上一页 / 下一页」。
- 每行映射成：`id`/`slug`、`owner`（`author` 或 `githubUsername`）、`name`（`displayName`，装成目录就用它）、`summary`（`description`，回退 `aiDescription`）、`category`、`risk`（`safe/medium/high/critical`）、`license`、`repository`、`quality`（`qualityScore`）、`hasScripts`、`needsNetwork`、`downloads`/`favorites`、`version`、`updatedAt`。缺 `slug` 的行丢弃。
- 注册表按描述做模糊匹配，会把名字无关的包排在前面，所以结果在服务端重排一次：名字全等 > 名字前缀 > 名字包含 > slug 包含 > 其余，同档保持注册表顺序。
- 内存缓存 60 秒、最多 24 条；注册表失败时返回上次成功的清单并标 `stale` + `error`，没有缓存则返回空清单与错误。超时 20 秒，5xx 重试 3 次。
- 注册表地址可用 `AGENT_MANAGER_STORE_URL` 覆盖（必须 http/https），指向任何实现同样三个接口的镜像即可。

**装 skill**：`POST /api/store/install`，请求体 `{ owner, slug, name?, agents? }`。

1. 先解析 `agents`：未知 agent 立刻 400，不发起任何网络请求。
2. 读 `GET <base>/api/skills/<slug>/manifest`：`skill.name` 是目录名（不是 slug），`artifact.url` 是 ZIP 地址，`artifact.sha256` 是校验值。
3. 目录名校验：只允许 `[A-Za-z0-9][A-Za-z0-9._-]*`，拒绝 `..`、路径分隔符和 Windows 保留名。目标 `~/.agents/skills/<name>` 已存在 → 409，**不覆盖**（删副本、改名是 Skills 页的决定）。
4. 下 ZIP：上限 20MB；校验本地文件头 `PK\x03\x04`（限流/代理可能回 200 + HTML）；有 `sha256` 时比对，不一致直接 502。
5. 解压前先在 `<dataDir>/tmp/store-*` 里落地：只读中央目录（归档用数据描述符，局部头里的尺寸是 0），支持 store / deflate，拒绝 ZIP64 与异常压缩方式；单项 8MB、总计 40MB、最多 1000 项。
6. 路径安全：绝对路径、盘符、`..` 段一律 400；全部条目共用一个顶层目录时剥掉它，所以「包一层」和「平铺」两种打包都能落到 `<skill>/SKILL.md`。
7. 校验存在 `SKILL.md`，否则 400；临时目录在 `finally` 里删掉，源目录里不留半个 skill。
8. 建快照（`created` = 源目标 + 每个要建的链接），再把临时目录 `move` 进源（跨卷退化为复制+删除）。链接用 junction；目标已有同名条目则记为 `skipped` 并保持原样，链接失败记为 `failed` 并进 `warnings`——skill 本体已经装好，不因此回滚。
9. 返回 `message / name / path / files / bytes / snapshotId / links[] / warnings[]` + 重扫的矩阵。还原这个快照会删掉新目录和它建的链接。

**双语显示**：`web/src/lib/store-i18n.ts` 保存商店页所有文案的中英两版，`StoreView` 用 `中文 / English / 双语`（默认双语，存 localStorage）渲染。只翻译界面词汇（按钮、状态、分类、风险级别、提示与确认框），**不翻译** skill 自己的名字、描述与许可证——那是发布者的原文，机器翻译会与真实内容产生偏差。

**不做**：升级/版本固定/降级、发布 skill、把安装结果记在源目录之外、执行 skill 里的任何东西、翻译 skill 正文。

## 已知限制

- 「源里已有」按目录名（manifest 的 `name`）或 slug 判断：不同发布者的同名 skill 也会显示为已有，点不了安装。
- 没有更新检查：注册表上的新版本不会提示，重新安装需要先移除旧目录。
- 注册表是外部服务：它挂掉时页面只能给出缓存与错误，不能离线安装。
- 分类与风险级别的中文是内置词表（12 个分类），注册表新增分类会直接显示英文 slug。

## Why

`~/.agents/skills` 是唯一源、agent 侧只有链接——安装因此只需写一处；把下载、校验、解压放在源目录之外的临时目录，再一次性 `move`，可以让失败不留下任何被扫描到的半成品。ZIP 读取器不引依赖，是因为只服务一个接口、只处理两种压缩方式，而任何第三方解压库都要额外处理同样的路径穿越与 zip bomb 风险。双语词典放在前端而不是服务端，是因为它只影响渲染，服务端返回值保持单份事实。
