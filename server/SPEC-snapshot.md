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

- **存储**：`<repo>/data/snapshots/<id>/`，`id` = `YYYYMMDD-HHmmss-<4 位随机>`；目录里是 `manifest.json` 与 `items/`。`data/` 已被 git 忽略。
- **备份语义**：文件与目录整份复制；符号链接只记录 `linkTarget`，不复制内容（避免把目标也复制一遍）；不存在的路径不记录。
- **`created`**：写操作新建的路径要登记进来，还原时删除。导入孤儿时登记的是「源里的新目录」，不是被替换的原路径——否则还原会先恢复再删掉。
- **还原顺序**：先按 `entries` 恢复（删除当前内容 → 复制备份回来），再删除 `created`。两者路径不得重叠，这是调用方的责任。
- **权限**：不做权限、所有者、时间戳的还原；只保证内容与结构。
- **已知限制**：损坏的 manifest 在列表里被跳过（不报错），但如果直接按 id 还原会抛错。

## 不负责

决定备份什么、什么时候备份；快照清理与保留策略（目前不删除，磁盘由使用者掌握）。
