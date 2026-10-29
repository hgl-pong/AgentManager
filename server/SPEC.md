---
id: module-scan
type: module-design
status: active
title: 扫描模块：把目录变成 skill × agent 矩阵
parent: architecture
---

## Responsibility

`server/scan.ts` 的唯一职责：给定一个源目录和若干 agent 目录，返回矩阵数据（每个 skill 在每个 agent 里的状态）。纯读、无副作用、无 HTTP、无缓存，因此可以直接对临时目录做单元测试。

## Boundary

**输入**：`scanMatrix({ source, agents })`，`agents` 是 `{key, label, root}` 列表；路径由调用方（`server/index.ts`）给出，扫描模块不读 `homedir()`。

**输出**：`Matrix`（见 `shared/types.ts`）——源 skill 列表、每个 agent 的 `detected`、以及行集合。行 = 源里的 skill ∪ 各 agent 目录里出现的 skill；源里的排在前，其余按名字排序。

**判定规则**：

| 磁盘上的样子 | 状态 |
| --- | --- |
| `lstat().isSymbolicLink()` 为真，`realpath` 在源目录内 | `linked` |
| 同上，`realpath` 在源目录外 | `external` |
| 同上，`realpath` 抛 ENOENT | `broken` |
| 实体目录，源里有同名 skill | `copy`（带 `hashMatch`） |
| 实体目录，源里没有 | `orphan` |
| 源里有，该 agent 目录里没有 | `missing` |

- 只有含 `SKILL.md` 的目录算 skill。容器目录（如 `~/.codex/skills/.system`）因此自然被排除；坏链无法验证，仍保留成行——它正是需要被看见的东西。
- 链接判定依赖 Node 在 Windows 上把 junction 报告为符号链接（实测成立），不使用 `cmd /c dir /AL`。
- 路径包含判定用导出的 `isInside(child, parent)`：Windows 下统一分隔符并忽略大小写，POSIX 保持原样逐字节比较；`child` 等于 `parent` 不算「在内部」。静态资源的前缀校验复用同一函数。

**哈希**：`hashDir` 递归收集 `相对路径:文件内容 sha256`，排序后合并再取 sha256。符号链接一律跳过，因此技能目录里的自指链接不会让遍历挂死。`copy` 与源同名 skill 各算一次比较，只暴露「一致 / 不一致」，不暴露 diff。

**已知限制**：判定只看条目名，不校验链接目标是否恰好是同名 skill；名为 X 的链接指向源里的 Y 时，会被记为 X 已链接（`target` 会在界面上暴露真实目标）。当前机器上没有这种布局。

**不负责**：提示词、settings / MCP、任何写操作、UI 展示。
