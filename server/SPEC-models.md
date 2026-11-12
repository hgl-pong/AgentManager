---
id: module-models
type: module-design
status: active
title: 模型目录：归一化 provider 返回的模型清单
parent: architecture
---

## Responsibility

`server/models.ts` 向 provider 的 OpenAI 兼容 `/models` 端点请求模型清单，归一化成前端可渲染的 `ModelInfo[]`。Provider 页展示这份清单，设置页的 model 字段复用它作为候选。

## Boundary

- **来源**：由 `server/providers.ts` 传入 active provider 的 base URL 与 API key；本模块不再读取界面里的 URL 输入。
- **鉴权**：提供 key 时发送 `Authorization: Bearer <key>`；key 只存在于请求头，不进入报告、缓存键或错误信息。
- **归一化**：兼容 OpenAI `{data:[…]}` 与 Codex `{models:[…]}` 两种载荷；保留 id、显示名、分组（`default` 或 `id` 前缀）、上下文窗口、最大输出、thinking/effort/图片/PDF 能力。无 id 的条目丢弃。
- **缓存**：内存缓存 60 秒；provider 的 `id + updatedAt` 作为缓存身份，修改 key/base URL 后自动失效。`?refresh=1` 强制刷新。端点失败时回退同 provider 的上次结果并标记 `stale` + `error`；没有缓存则返回空列表与错误。
- **超时**：10 秒；只接受 http/https 源。
- **不做**：写配置文件（provider 存储由 `providers.ts` 负责）、代理模型推理请求、校验模型是否存在于 pi 的 `models.json`。

## Why

模型清单是运行期数据，不该写死进 catalog。Provider 负责「去哪里、用什么 key」，本模块只负责「取回来并归一化」；设置页因此只关心候选，不再维护模型源。
