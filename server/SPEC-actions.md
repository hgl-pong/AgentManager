---
id: module-actions
type: module-design
status: active
title: skills 写操作：建链、导入孤儿、移除副本
parent: architecture
---

## Responsibility

`server/actions.ts` 是唯一会改动 `~/.agents/skills` 与各 agent skills 目录的模块。三个动作，每个都先建快照，再动文件。

## Boundary

| 动作 | 前提 | 结果 | 快照记录 |
| --- | --- | --- | --- |
| `link` | 源里有该 skill；目标位置不存在 | 目标位置出现指向源的 junction | `created: [目标]` |
| `import` | 目标位置是独立目录且含 SKILL.md；源里没有同名 skill | 目录移入源，目标位置变成指向源的 junction | `entries: [原目录]`、`created: [源里的新目录]` |
| `remove` | 目标位置是独立目录（不是链接） | 目录被删除（内容留在快照里） | `entries: [原目录]` |

- **不覆盖**：目标位置已有任何东西（含悬空链接）时 `link` 直接报错，由人来决定是副本、链接还是坏链。
- **移动**：同盘用 `rename`，跨盘（EXDEV）退化为复制后删除。
- **边界校验**：skill 名不得含路径分隔符，最终路径必须落在给定根目录内；这是防止路径穿越的唯一关卡，因为请求体来自浏览器。
- **不做**：批量操作、把副本替换成链接、编辑 skill 内容。

## 为什么这样切

把「副本 / 链接 / 坏链」的取舍留给使用者，是因为自动判断会在一次点击里毁掉一份真实内容；而 `remove` 之所以敢删，是因为快照先落地。
