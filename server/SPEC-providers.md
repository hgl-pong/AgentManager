---
id: module-providers
type: module-design
status: active
title: 模型 provider：来源、密钥与 active 选择
parent: architecture
---

## Responsibility

`server/providers.ts` 管理 `~/.agents/providers.json`：多个 OpenAI 兼容 provider、一个 active、模型读取。它是唯一的 provider 写入者，也是 API key 的唯一持有者。

## Storage

```json
{
  "activeId": "provider-ab12cd34",
  "providers": [
    {
      "id": "provider-ab12cd34",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "sk-…",
      "createdAt": "2026-11-12T00:00:00.000Z",
      "updatedAt": "2026-11-12T00:00:00.000Z"
    }
  ]
}
```

- 每个 provider 只有 `baseUrl` 与 `apiKey` 是用户输入；显示名由 base URL 的 host 派生，不额外要求名称。
- 新 provider 自动成为 active；修改 base URL/key 后更新 `updatedAt`，模型缓存随之失效。
- 删除 active provider 后切到剩余列表的第一个；删完则 `activeId: null`。
- 文件不存在时读为空列表；存在但无法解析或条目无效时报 500，不静默丢弃用户的 provider。
- API key 以明文保存在本机文件，写入后尽量 `chmod 0600`；这是单机单用户的本地工具，不做加密。

## API

| 路由 | 作用 | 写入/快照 |
| --- | --- | --- |
| `GET /api/providers` | 返回 `ProvidersReport`，含 activeId 与每个 provider 的 `hasApiKey`，**不含 key** | 否 |
| `POST /api/providers/save` | 新建（`id` 省略，必须有 key）或更新（`id` 存在；key 留空保留原 key） | 是 |
| `POST /api/providers/activate` | 把某个 provider 设为 active | 是 |
| `POST /api/providers/remove` | 删除 provider，必要时切换 active | 是 |
| `GET /api/providers/models?refresh=1` | 用 active provider 的 key 读取 `/models`，返回 `ProviderModelsReport` | 否 |

- 写入都走全局写队列，并先对 provider 文件建快照；失败时给快照标 `[失败]`。
- provider 文件路径也在快照还原的允许根里，因此撤销快照可以恢复 provider。
- 所有写接口按服务端既有规则校验 Host、Origin 与 JSON Content-Type。
- `ProvidersReport.source` 是 provider 文件路径；不暴露 key。
- `ProviderModelsReport` 在 `ModelsReport` 上增加 `provider`（active 的公开摘要），没有 provider 时返回空列表和「还没有配置 provider」错误。

## Boundaries

- 只管 OpenAI 兼容的 `/models`（Bearer key）；不保存、代理或调用具体模型。
- 不做 provider 预设、分组、优先级或自动故障转移；一次只有一个 active。
- 不写任何 agent 配置文件；设置页的 model 字段仍由 settings 模块写入。
- 不把 API key 返回给浏览器，也不写进日志、错误消息或模型缓存。

## Why

模型来源从「一个隐式环境变量」变成用户可核对、可切换、可撤销的本地配置。把 key 关在服务端，Provider 页只做选择与展示，设置页只消费模型清单，职责边界最清楚。
