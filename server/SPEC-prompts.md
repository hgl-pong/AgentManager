---
id: module-prompts
type: module-design
status: active
title: 提示词模块：单一源与两个 agent 的合流
parent: architecture
---

## Responsibility

`server/prompts.ts` 把 `~/.agents/prompts/global.md` 作为全局提示词的唯一正文，并让 `~/.claude/CLAUDE.md` 与 `~/.codex/AGENTS.md` 指向它。它同时负责判断每个目标当前是同步、漂移、缺失还是坏链。

## Boundary

- **状态**：`no-source`（源未建立）/ `missing` / `synced` / `drift` / `broken` / `external-link`。以内容哈希为准；「链接方式」是附加信息，不参与状态判断。
- **链接方式**：硬链接优先——它不需要开发者模式或管理员权限，且编辑任意一端都会改到同一份内容。失败回退符号链接，再失败退化为复制并在状态里体现为 `copy`。
- **初始化**：源不存在时，以 `primaryKey`（claude）的文件内容建源；随后把每个目标替换为指向源的链接。整批替换前统一建一次快照，并把新建的源文件登记进 `created`，还原时一并删除。
- **对齐**：只处理一个目标，先快照该文件再替换。
- **不做**：合并两份提示词的内容（迁移只取 claude 那份）、按 agent 生成不同变体、写回 settings。

## 已知限制

硬链接在目标被「写新文件再改名」的编辑器替换后会断链，此时状态变为 `drift`——可见、可一键对齐，但不会自动修复。
