---
id: module-mcp
type: module-design
status: active
title: MCP 单一源与跨 agent 同步
parent: architecture
---

## Responsibility

`server/mcp.ts` 管理唯一的 MCP 源文件 `<home>/.agents/mcp/servers.json`，把它与三家 agent 的 MCP 配置做对比（矩阵）并按需同步。skills 用「源目录 + 链接」；MCP 没有链接机制，所以改为「唯一源文件 + 写入各 agent 配置」。

agent 文件**只通过** `server/settings.ts` 的 `readSettings` / `saveSettings` 读写，复用其 etag、MCP 校验、快照与原子写；本模块不直接 fs 写 agent 文件。

| agent | 设置注册表 id | 文件 | MCP 键 | 写法 |
| --- | --- | --- | --- | --- |
| claude | `claude-mcp`（scope mcp） | `~/.claude.json` | `mcpServers` | 写 `type`、`headers`；其余键原样保留 |
| codex | `codex-config`（full, TOML） | `~/.codex/config.toml` | `mcp_servers` | 不写 `type`；headers 写为 `http_headers`；以 `text` 提交，保留 TOML 原生值（日期） |
| pi | `pi-mcp`（full, JSON） | `~/.pi/agent/mcp.json` | `mcpServers` | 写 `type`、`headers` |

codex 与 pi 不支持 sse。

## 源文件

```json
{ "version": 1, "servers": { "<name>": { "transport": "stdio|http|sse", "command": "", "args": [], "env": {}, "cwd": "", "url": "", "headers": {} } } }
```

- 缺失 → 空源（`exists: false`）。
- JSON 非法、根不是对象、`servers` 不是对象、或非 ENOENT 读失败 → `source.error`；此时**所有**写动作 400。
- 单个条目无效（手工编辑导致）不让整个源出错：该行 `source` 缺省，所有格子 `invalid`（error 以「源定义无效」开头）；全量 sync 跳过并 warning。
- 写入：根对象的其他键保留，`version` 缺省补 1；2 空格 JSON + 末尾换行；`createSnapshot(snapshotRoot, 'mcp source', [sourcePath])`，文件原本不存在时登记为 created；再用 `settings.ts` 导出的 `writeAtomically`（同目录临时文件 + rename，Windows EPERM/EBUSY 重试）。写失败给快照打 `[失败]` 标记。
- 源路径存入 `AppConfig.mcpSource`，加入 `/api/open` 白名单和快照还原允许根。

## 归一化与比较

`McpServerDefinition` 是中立形状。只比较核心字段 `transport / command / args / env / cwd / url / headers`，且只比较该 transport 适用的字段（stdio：command/args/env/cwd；http/sse：url/headers）。空数组、空对象、空串归一为 undefined。env/headers 比较与键序无关。

agent 条目 → 中立定义：

- transport：`type` 为 `stdio`/`http`/`streamable-http`/`sse`（大小写不敏感，`streamable-http`→`http`）；无 `type` 时有 url → http，否则 stdio；其它 `type` 值 → 无效。
- Codex 的 headers 读 `http_headers`，也接受 `headers`（同键 `http_headers` 优先）。
- 忽略 agent 特有字段（Codex 的 `bearer_token_env_var`、`env_http_headers`、`enabled`；pi 的 `oauth`、`toolExposure` 等）。

中立定义 → agent 条目（合并）：按已有条目的键序逐个复制，未知字段原样保留；核心键（`type/command/args/env/cwd/url/headers/http_headers`）用新值替换，不再适用的（包括切换 transport 后的）删除；新增核心键追加在末尾。

## 矩阵（`GET /api/mcp` → `McpMatrixReport`）

每次请求实时读取，无缓存。`agents` 按 claude、codex、pi 返回 `key/label/file/format`（`file` 为注册表 `path`）。

| 情况 | state |
| --- | --- |
| 源无该名，agent 有 | `orphan`（仅为拥有该条目的 agent 生成格子） |
| 源 transport=sse 且 agent 为 codex/pi | `unsupported`（不论 agent 是否有条目） |
| agent 无该条目 | `missing` |
| agent 文件无法解析 / MCP 键不是对象 | `invalid`（error 指出文件） |
| 条目不是对象或无法归一化 | `invalid`（带 error） |
| 归一化后一致 / 不一致 | `synced` / `drift` |

- 源行为每个 agent 都生成格子；孤儿行只有拥有该条目的 agent 有格子。两者都不在 → 无行。
- `summary`：stdio 为 `command + args`，`--token`/`--api-key` 等标志的下一个参数、`--token=x` 形式及 token 形值打码；http/sse 为去掉 `user:pass@` 的 url。仅用于展示，不参与比较。打码逻辑与 `server/config.ts` 相同（复制而非共享，因为 config.ts 不在本模块所有权内）。
- `row.source` 与 agent 数据保留真实值；打码是界面的责任。
- 排序：源内行在前，再按名称 `localeCompare`。

## 动作（`POST /api/mcp`，body `McpActionRequest` → `McpActionResponse`）

经 `assertLocalWrite` 与 app.ts 写队列串行执行。响应含 `message`、`snapshotIds`、`warnings`、`report`（动作后的实时矩阵）。

| action | 参数 | 行为 | 快照 |
| --- | --- | --- | --- |
| `import` | name, agent | 读该 agent 的有效定义，写入/覆盖源同名项。条目缺失 404，无效 400 | 源 1 条 |
| `importAll` | prefer?（默认 claude） | 只补源中没有的名称；候选顺序 prefer，再 claude→codex→pi 的第一个有效定义；其它有效定义与之不同时 warning `name：以 <label> 为准`；无效名称/无有效定义跳过并 warning；已有源项不改。无可导入项则不写 | 源 1 条（或 0） |
| `saveSource` | name, server, agents? | 校验并写入/覆盖源；agents 非空时随后同步该 server 到这些 agent | 源 1 条 + 每个改动的 agent 文件 1 条 |
| `deleteSource` | name | 从源删除（不存在 404）；agent 配置不动，之后显示为孤儿 | 源 1 条 |
| `sync` | name?, agents?（也接受单个 agent） | name 缺省 = 源中全部 server；agents 缺省 = 全部 agent。每个 agent 文件最多保存一次；内容已一致的不写；sse → codex/pi 跳过并 warning | 每个改动的 agent 文件 1 条 |
| `remove` | name, agent | 从该 agent 的 map 删除（不存在 404） | 该 agent 文件 1 条 |

保存 agent 文件时 map 为空则删除该 MCP 键。

### 校验（400）

- name：非空、≤100 字符、不含 `/` 或 `\`。
- transport ∈ stdio/http/sse；stdio 必须有非空 command；http/sse 必须有非空 url。
- args 为字符串数组；env/headers 为 string→string 对象；cwd 为字符串。不适用于该 transport 的字段在通过类型校验后被丢弃。
- 未知 action、未知 agent / prefer、agents 不是数组 → 400。
- 源损坏 → 所有动作 400。

### 失败语义

agent 文件写入失败（含 `saveSettings` 的 409/400，例如该文件中有别的无效 MCP 条目）会让整个动作报错；之前已完成的写入不回滚，但都已有快照可还原。

## 测试

`server/mcp.test.ts`：每个用例使用独立临时 home，覆盖孤儿/缺失、import、sync 的 TOML/JSON 形状、drift 与未知字段保留、transport 切换、importAll 优先级与 warning、deleteSource、remove、sse unsupported、invalid、校验 400、快照还原、源损坏，以及进程内启动的 `GET/POST /api/mcp`（报告形状、写守卫 415、400、写后 report）。
