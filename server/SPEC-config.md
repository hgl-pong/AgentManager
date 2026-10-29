---
id: module-config
type: module-design
status: active
title: 配置模块：settings 与 MCP 的只读对比
parent: architecture
---

## Responsibility

`server/config.ts` 读取三个 agent 的配置文件，产出一份只读对照：每个文件的顶层键摘要，以及跨 agent 的 MCP server 分布。它没有任何写路径。

## Boundary

- **输入**：`ConfigFileSpec[]`，由调用方列出文件、格式（`json` / `toml`）与角色。目前包括 `~/.claude/settings.json`、`~/.claude.json`、`~/.codex/config.toml`、`~/.pi/agent/settings.json`。
- **解析**：`JSON.parse` 与 `smol-toml`。解析失败不抛错——文件仍然列出，`error` 字段带原因，其余文件照常。
- **MCP**：JSON 取 `mcpServers`，TOML 取 `mcp_servers`，按名字合并成矩阵。同一个 agent 可在两个文件里定义同一个 server，因此每格是数组而不是单值。
- **脱敏**：键名匹配 `key|token|secret|password|auth` 的字符串值在页面上替换为 `••••••`；页面上不应出现真实密钥。
- **大文件**：`~/.claude.json` 有上百 KB 状态数据，`listKeys: false` 让它只贡献 MCP，不贡献键列表。
- **不做**：写回、逐字符 diff、类型校验、按项目维度聚合。

## 为什么只读

四种配置格式语义不同，字段级「合并」没有共同含义；写错一个 agent 的 settings 会让它起不来。对比 + 交给编辑器是这句话的边界。
