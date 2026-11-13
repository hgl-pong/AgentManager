---
id: module-model-package
type: module-design
status: active
title: 模型应用：按 agent 格式打包写入 provider 与模型
parent: architecture
---

## Responsibility

`server/model-package.ts` 把 active provider 和用户选中的模型写进选中的 agent。它不是只改一个 model 字符串，而是按每个 agent 的配置格式写入 provider、认证、模型和能拿到的模型能力。

## API

| 路由 | 作用 |
| --- | --- |
| `GET /api/model/targets` | 返回每个 agent 会写入的配置文件路径与是否已检测到 |
| `POST /api/model/apply` | `{ modelId, agents }`，用 active provider 的当前模型清单校验后写入选中 agent |

- 写入走全局写队列；每个文件独立建快照，响应返回 `snapshotIds`。
- 只使用服务端保存的 provider key，客户端不提交 key；响应与错误信息都不包含 key。
- 模型必须仍在 active provider 的当前清单里；找不到返回 404，不凭客户端提供的元数据写入。

## Per-agent packages

| Agent | 文件 | 写入内容 |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json` | `model`；`env.ANTHROPIC_BASE_URL`（provider base，去掉末尾 `/v1`）、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL`、四个默认模型、`CLAUDE_CODE_SUBAGENT_MODEL`、`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`；模型声明 effort 时补 `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1`；有 contextWindow 时写 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` |
| Codex | `~/.codex/config.toml` | `model`、`model_provider = "agentmanager"`、`[model_providers.agentmanager]`（name、base_url、wire_api=responses、requires_openai_auth=true、experimental_bearer_token=key）、`model_context_window`；保留 `model_catalog_json` 与其他 provider |
| pi | `~/.pi/agent/models.json` + `~/.pi/agent/settings.json` | `providers.agentmanager`（baseUrl、api=openai-completions、apiKey、authHeader、compat、全部模型及 contextWindow/maxTokens/reasoning/input/thinkingLevelMap/cost）；`defaultProvider=agentmanager`、`defaultModel=选中的模型` |

- **合并而不是覆盖**：Claude/Codex/pi settings 保留用户在文件里的其他键；pi models.json 保留其他 provider。Codex 与 pi 只拥有固定 id 的 `agentmanager` 条目。
- **Claude base URL**：Claude SDK 会再拼 `/v1/messages`，所以写入前移除 provider base 末尾的 `/v1`；Codex 与 pi 保留 `/v1`。
- **Codex catalog**：按当前取舍保留现有 `model_catalog_json`，不由本模块生成或删除。
- **模型能力**：Claude 的 effort 开关来自 `ModelInfo.effort`，context 来自 `ModelInfo.contextWindow`；Codex 的 context window 来自 `ModelInfo.contextWindow`；pi 写入完整能力字段与 thinkingLevelMap（按 `effortLevels` 映射，未支持的档位为 null）。
- **校验**：Claude/Codex/pi settings 复用 `saveSettings` 的 schema 校验、etag 与原子写；pi models.json 不是 settings schema 文件，走独立 JSON 校验与快照。
- **失败**：某个文件写入失败会中止该次应用并保留已完成文件的快照；重试是幂等的（固定 provider id，合并语义）。

## Why

模型不是跨 agent 通用的一个字符串：Claude Code、Codex、pi 对 provider、认证和模型元数据各有格式。把「选择来源」和「写入 agent」分成 Provider 页与一次完整应用，避免设置页某个 model 字段看起来写成功、实际却缺少 base URL/key/context 的情况。
