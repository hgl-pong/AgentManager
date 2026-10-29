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
- 先只读，再写：任何写操作都要能回滚（goal 文档的快照能力）。

## Decisions

两个进程，一条 `npm run dev`：

```
浏览器 → Vite 5173（/api 代理）→ Node API 7788 → scan.ts → 文件系统
```

- **后端跑源码**：Node 24 原生剥离类型，`node server/index.ts` 直接运行 `.ts`，不引入构建步骤或 tsx。`tsc --noEmit` 只用于类型检查。
- **契约共享**：`shared/types.ts` 同时被 `server/` 与 `web/` 导入，API 形状只定义一次。
- **每次请求实时扫描**：`GET /api/matrix` 每次重新读目录、重算哈希。实测 477 个文件 / 8MB 约 15ms，缓存只会带来过期状态。
- **前端用 Vite + React 而不是服务端直出**：后续的建链、删除确认、快照回滚都是带状态的交互，先把骨架搭好，比先写 SSR 再重写少一轮返工。
- **链接是首选共享方式**：目录用 Windows junction；这决定扫描必须以「链接 / 实体」而非「文件内容」为主轴。

## Invariants

- 扫描不写任何文件；页面上的数字必须能在磁盘上复现。
- API 只监听 `127.0.0.1`。
- 新增 agent 只需在 `server/index.ts` 的清单里加一条 `{key, label, root}`，不动扫描逻辑。
- 前端不自己推导状态：格子显示的是后端给出的 `state`，不在浏览器里重新判断链接或哈希。

## Out of scope

- 提示词合流、settings / MCP 解析（goal 里后续的能力，届时各自决定归属）。
- 项目级目录扫描。
- 多用户、远程访问、安装包。
