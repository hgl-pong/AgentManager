---
id: module-models
type: module-design
status: active
title: 模型目录：从本地 OpenAI 兼容端点读取模型清单
parent: architecture
---

## Responsibility

`server/models.ts` 向本地 OpenAI 兼容端点请求模型清单，归一化成前端可渲染的 `ModelInfo[]`。设置页的「模型」页签与模型字段候选都来自这里。

## Boundary

- **来源**：默认 `http://127.0.0.1:15721/v1/models`；可用环境变量 `AGENT_MANAGER_MODELS_URL` 覆盖，或在「模型」页签直接填写模型源 URL（base URL 或完整的 `/models` URL），通过 `GET /api/models?url=...` 传入。
- **归一化**：兼容 OpenAI `{data:[…]}` 与 Codex `{models:[…]}` 两种载荷；保留 id、显示名、分组（`default` 或 `id` 前缀）、上下文窗口、最大输出、thinking/effort/图片/PDF 能力。无 id 的条目丢弃。
- **缓存**：内存缓存 60 秒；`GET /api/models?refresh=1` 强制刷新。端点失败时返回上次成功的缓存并标记 `stale` + `error`；没有缓存则返回空列表与错误，界面仍允许手动输入模型 ID。
- **超时**：5 秒；只接受 http/https 源。
- **不做**：写配置文件（由 settings 模块负责）、校验某个模型是否存在于 pi 的 `models.json`、代理模型推理请求。

## Why

模型清单是运行期数据，不应该写死进 catalog；本地端点换了模型后，刷新即可在三个 agent 的配置里选择。读取失败不阻塞设置页，模型字段退回为可自由输入的文本框。
