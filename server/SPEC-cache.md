---
id: module-cache
type: module-design
status: active
title: 缓存模块：把会话记录与缓存收进回收站
parent: architecture
---

## Responsibility

`server/cache.ts` 管的是「agent 目录越来越大」这件事：列出三个 agent 已知的会话记录与缓存位置、显示各占多少和有多老，并把用户选中的部分移进回收站。它是唯一会删除 agent 运行时数据的模块，因此把「可回滚」做成结构性的：清理只是移动，唯一不可逆的动作是用户单独确认的 `purge`。

## Boundary

- **目标清单在服务端**：`cacheTargets(home)` 生成 `{id, agent, label, path, kind, risk, note, openPath}`；前端只提交 `id`，`runCacheAction` 按 id 查表，未知 id 返回 400。请求体里没有任何路径，所以客户端无法指定删除目标。
- **三类目标**：`dir`（整目录或按文件 mtime 过滤）、`file`（单个文件）、`glob`（`*` 通配，只匹配文件，不匹配目录）。`openPath` 是「打开」按钮的目标：glob 取父目录。
- **保护名单**：`PROTECTED_NAMES` 列出所有活配置文件名（`settings.json`、`config.toml`、`AGENTS.md`、`auth.json`、`models.json`、`servers.json`…）。glob 匹配时过滤掉它们；显式的 `file` 目标命中时报错（扫描记 `error`，清理返回 500）而不是删除——这是配置永不写入、也不被清理的兜底。
- **年龄分档**：一次遍历同时累计 `CACHE_AGE_BUCKETS = [1, 7, 30, 90]` 天四个分档（各自是「超过 N 天」的累计值），界面据此显示「范围内」的数字而不必二次请求。`olderThanDays: 0` 表示整体清理；其余值只移动更老的文件。
- **sqlite 组**：`*.sqlite(-wal|-shm|-journal)` 视为一组（`groupKey`），组内任一文件新于截止时间就整组跳过——删掉旧的 `.sqlite` 而留下正在写的 `-wal` 会损坏数据库。
- **链接一律跳过**：不测量、不移动、不跟随。链接环不会挂住扫描，目标目录外的内容也不会被统计或删除。
- **空目录**：部分清理后自底向上删除被清空的子目录（`pruneEmptyDirs`），目标根目录本身保留。
- **回收站**：`<dataDir>/recycle/<id>/`（`AGENT_MANAGER_CACHE_RECYCLE` 可覆盖），`id = YYYYMMDD-HHmmss-<8 位随机>`；目录里是 `manifest.json` 与 `items/`。manifest 记录每条 `{originalPath, storedPath, kind, bytes, files}`，`createdAt` 与 `operation` 由服务端写。
- **移动而不是复制**：`movePath` 先 `rename`（同卷即时完成，GB 级内容也是瞬间），只有 `EXDEV` 跨卷才 `cp + rm`。因此清理后磁盘占用真正下降（内容只存在于回收站），而「彻底删除」只释放回收站那一份。
- **失败可恢复**：manifest 在第一次移动之前就写一次，之后每移动成功一项就重写一次；移动途中抛错时再写一次并返回 500，说明「N 项已移入回收站并可恢复，原因是…」。进程被杀（Ctrl+C、`--stop`、断电）时 catch 跑不到，但 manifest 始终覆盖已经移动的那部分，不会出现「文件已被移走但没人知道」的状态。
- **还原**：原位置已被占用（agent 又写回了同名文件）或备份缺失时不覆盖、不删除，条目留在回收站并在响应 `skipped` 里列出；全部恢复成功后删除条目目录。还原前后端会重新扫描并返回完整报告。
- **校验**：`id` 只允许 `[A-Za-z0-9._-]` 且不含 `..`，解析后必须仍在回收站根内；manifest 的 `storedPath` 必须在条目目录内，`originalPath` 必须落在某个目标的根内（`dir` 目标即自身，`file`/`glob` 取父目录），越界返回 400。形状不对的 manifest 返回 400，列表则跳过坏条目。
- **扫描只读**：`scanCache` 只 `lstat`/`readdir`，回收站目录在第一次清理之前不存在。测试对此有断言。
- **这里不用 `createSnapshot`**：快照会把内容整份复制一份，对 500MB 会话目录等于「清理前先翻倍占用」；回收站本身就是快照——内容原样存在、结构可还原。写操作仍然可回滚，只是回滚入口在「缓存」页而不是「快照」面板。

## 不负责

判断哪些位置算缓存之外的数据（清单是人工维护的白名单）；与正在运行的 agent 协调（清理后 agent 会重新创建目录，正在写的大文件可能已经移动）；回收站的自动过期与容量上限（目前只在「清空回收站」时释放）。