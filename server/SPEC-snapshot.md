---
id: module-snapshot
type: module-design
status: active
title: 快照模块：写操作的后悔药
parent: architecture
---

## Responsibility

`server/snapshot.ts` 负责在每次写操作之前把将被改动的东西存下来，并在需要时原样还原。它是「写操作可回滚」这条不变量唯一的实现处：任何写路径都必须先经过它。

## Boundary

- **存储**：`<repo>/data/snapshots/<id>/`，`id` = `YYYYMMDD-HHmmss-<8 位随机>`；目录里是 `manifest.json` 与 `items/`。`data/` 已被 git 忽略。随机段为 4 字节，同名目录已存在时重试，同一秒内连续写不会撞 id。
- **备份语义**：文件与目录整份复制；符号链接只记录 `linkTarget`（工作链接取 `realpath`，悬空链接回退到 `readlink`），不复制内容（避免把目标也复制一遍）；不存在的路径不记录。
- **链接类型**：`linkType` 由 `statSync` 跟随目标后判断——目录为 `junction`，文件为 `file`；悬空链接无从判断，回退 `junction`。还原时按此重建，文件链接不再被误建成 junction。
- **链接的删除与还原**：移除链接一律用 `unlink`，不用 `rm -r`。Windows 上对悬空 junction 执行 `rmSync` 后立即重建会得到 `EEXIST`，`unlink` 没有这个问题。只有在真正重建成功的路径才会进入 `restored`。
- **备份缺失**：`storedPath` 不存在时只记 `missing`，绝不再先删除现场——拿不回来的内容不能被删。
- **`created`**：写操作新建的路径要登记进来，还原时删除。导入孤儿时登记的是「源里的新目录」，不是被替换的原路径——否则还原会先恢复再删掉。
- **还原顺序**：先按 `entries` 恢复（删除当前内容 → 复制备份回来），再删除 `created`。两者路径不得重叠，这是调用方的责任。
- **可撤销的还原**：`restoreSnapshot` 在动手前先把将被触碰的路径（`entries[].originalPath` ∪ `created`）存成一份 `writeInPlace` 快照，`operation` 记为 `restore <原 id>`，并把该快照 id 一并返回；再还原这份快照即可退回还原前的状态。备份失败则还原中止，一个字节都不动。
- **边界**：`id` 只允许字母、数字与 `.` `_` `-`，且不得含 `..`；解析后的目录必须位于快照根内。manifest 的 `entries[].originalPath` 与 `created[]` 必须落在调用方给出的允许根内（源、各 agent skills 根、提示词源与目标），否则 400。
- **manifest 校验**：还原前校验 `id`/`operation`/`entries[]`/`created[]` 的类型，形状不对返回 400；列表对损坏或被篡改的 manifest 直接跳过。
- **失败标记**：动作在快照之后抛错时，调用方用 `markSnapshotFailed` 给 `operation` 加 `[失败] ` 前缀；快照保留，便于人工判断和回滚。
- **权限**：不做权限、所有者、时间戳的还原；只保证内容与结构。

## 不负责

决定备份什么、什么时候备份；快照清理与保留策略（目前不删除，磁盘由使用者掌握）。
