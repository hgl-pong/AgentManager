---
id: module-settings
type: module-design
status: active
title: settings 编辑模块：用户级配置的读写引擎
parent: architecture
---

## Responsibility

`server/settings.ts` 是唯一会写 agent 用户级配置文件的模块。它把五个固定的配置文件注册成可编辑对象，提供读取（含 etag）、按结构化数据或原始文本保存、字段校验、MCP 校验、快照与原子写入。`server/config.ts` 的只读对比完全不受影响：两套 API 并存，各读各的。

## 文件注册表

路径全部由 `createAppConfig` 的 `home` 派生，测试用临时 home，绝不触碰真实用户目录。

| id | agent | 路径 | 格式 | scope | mcpKey |
| --- | --- | --- | --- | --- | --- |
| `claude-settings` | claude | `~/.claude/settings.json` | json | full | — |
| `claude-mcp` | claude | `~/.claude.json`（`hostPath` 相同） | json | mcp | `mcpServers` |
| `codex-config` | codex | `~/.codex/config.toml` | toml | full | `mcp_servers` |
| `pi-settings` | pi | `~/.pi/agent/settings.json` | json | full | — |
| `pi-mcp` | pi | `~/.pi/agent/mcp.json` | json | full | `mcpServers` |

- `scope: full`：`data` 是文件根对象，`text` 是规范化后的整份文本。
- `scope: mcp`：只有 `claude-mcp`。`data` 仅是 `mcpServers` 映射，`text` 是该映射的 JSON；磁盘上真正读写的是宿主文件 `~/.claude.json`，其余键原样保留。
- `full` 文件带 `mcpKey` 时（`codex-config`、`pi-mcp`），保存时额外校验该键下的映射，但 `data`/`text` 仍是整份文件。
- 五个路径与 `hostPath` 都加入 `/api/open` 白名单；快照还原的允许根目录也包含这些路径。

## HTTP API

### `GET /api/settings/catalog`

直接返回 `server/settings-catalog.ts` 的 `SETTINGS_CATALOG`（由 `scripts/build-settings-catalog.mjs` 从 `schemas/` 生成，禁止手改）。这是字段目录，不是当前值。

### `GET /api/settings`

返回 `SettingsReport`，按 agent 分组。每个文件返回注册表描述符加上：

- `exists`：只把 `ENOENT` 当作不存在；其他读失败（权限、目录当文件）是 500，不伪装成缺失。
- `etag`：宿主文件**原始文本**的 sha256（hex）；文件不存在时是固定字符串 `missing`。
- `bytes`：原始文本 UTF-8 字节数（缺失时省略）。
- `data`：`full` 是根对象，`mcp` 是映射；TOML 的 `TomlDate` 等非 JSON 值在返回前转成字符串，保证 JSON 响应安全。
- `text`：可交给原始编辑器的规范化文本（JSON 2 空格缩进；TOML 用 `smol-toml` 序列化），总以换行结尾。`mcp` 文件只有映射本身。
- `parseError`：解析失败时给出原因，此时不返回 `data`/`text`，但 `etag` 仍然可用（客户端仍可提交原始文本来修复）。

**密钥不脱敏**：设置编辑器需要真实值，GET 原样返回。打码是界面的责任；只读对比视图继续使用 `server/config.ts` 的脱敏逻辑。

### `POST /api/settings/save`

请求体 `SettingsSaveRequest`：`{ fileId, etag, data?, text? }`。`text` 存在时优先，`data` 被忽略。

1. `fileId` 必须命中注册表，否则 404。请求只接受 id，不接受路径，因此路径穿越没有入口。
2. 读取宿主文件当前文本；`etag` 不等于当前值 → 409「已被外部修改」。缺失文件用 `missing` 参与比较。
3. 有 `text`：按文件格式解析（JSON.parse / smol-toml），解析失败 400。
4. 无 `text`：取 `data`，按格式序列化（JSON 2 空格；TOML `smol-toml stringify`），补末尾换行。
5. 校验（见下）。失败 400，不建快照、不写文件。
6. `createSnapshot(snapshotRoot, "settings <fileId>", [hostPath])`；保存前文件不存在时把 hostPath 记入 `created`，因此还原快照会删掉这个新文件。
7. 原子写入：同目录临时文件 + `rename`。Windows 上 `EPERM`/`EBUSY` 重试 6 次（间隔递增），每次失败清理临时文件；最终失败 500 并给快照加 `[失败]` 标记。
8. 重新读取文件，返回 `SettingsSaveResult { snapshotId, file }`，其中 `etag` 是新内容的 sha256。

所有 POST 仍经过 `app.ts` 的 `assertLocalWrite`（Host、Origin、Content-Type）和全局写队列；两次并发保存同一文件会串行执行，后一次拿到旧 etag 时返回 409。

## 校验规则

### 字段校验

以 `SETTINGS_CATALOG` 中对应 agent 的字段目录为准，递归校验**存在的已知键**：

- `string` / `number` / `integer` / `boolean` / `array` / `object` 检查类型；整数字段拒绝小数，数字字段拒绝 `NaN`/`Infinity`。
- `enum` 必须精确命中；`minimum` / `maximum` 只作用于数字。
- 嵌套 `object.fields` 递归；`map` 对象的值按 `mapValue` 校验（例如 `env` 必须是字符串映射）。
- `array.items` 逐项校验（例如 `availableModels` 必须是字符串数组）。
- `json` 类型字段接受任何合法 JSON 值。
- **未知键一律允许并保留**：不认识的顶层键、嵌套键都原样写回（`data` 模式要求客户端把它们带回来；整份替换语义）。

每条错误带字段路径（如 `permissions.defaultMode`、`env.ANTHROPIC_API_KEY`），状态 400。

### MCP 校验

对 `mcpKey` 下的每个 server：

- 名称非空、不能含 `/` 或 `\`。
- server 必须是对象；`type`、`command`、`url` 若存在必须是字符串。
- `type` 为 `http` / `sse` → 必须有非空 `url`；`type` 为 `stdio` → 必须有非空 `command`；无 `type` 时 `command` 或 `url` 至少有一个（兼容 Codex 只写 `url` 的远端配置）。
- `args` 必须是字符串数组；`env`、`headers` 必须是字符串到字符串的映射。

### Claude MCP 合并

`claude-mcp` 的保存不是整份替换：

1. 读取完整 `~/.claude.json`（不存在按 `{}`）。
2. 解析失败 → 400，因为无法安全保留其余状态数据。
3. 用提交的映射替换 `mcpServers`；映射为空对象时删除该键。
4. 其余顶层键（`projects`、`history` 等）按解析结果原样保留，然后整体序列化为 2 空格 JSON 写回。

### 原始文本模式

- JSON / TOML 文本先解析再按同一套规则校验；非法文本 400，磁盘内容不变。
- 合法文本按原文写入，只补末尾换行；不重新格式化。
- `claude-mcp` 的 `text` 是该映射的 JSON，写入前仍要与宿主文件合并，所以磁盘上永远是合并后的整份 JSON。

## 已知限制

- **整份替换语义**：`full` 文件的 `data` 模式会替换整个文件；客户端若丢弃未知键，它们也会被丢弃。原始文本模式同样按提交文本整体写入。
- **格式与注释不保留**：结构化保存会重新序列化，TOML 注释、键顺序细节、空白都会丢失。需要保格式时走原始文本模式。
- **TOML 日期在 `data` 中是字符串**：为避免 JSON 响应出现非标准值，GET 把 `TomlDate` 转成 ISO 字符串。用结构化数据再保存会把日期写成字符串；需要保留日期类型时用原始文本模式。
- **TOML 无 null**：包含 `null` 或其他无法 round-trip 的数据会被 400 拒绝，而不是静默丢键。
- **不跟随符号链接**：原子写入用 rename 换掉目标路径；若配置文件本身是符号链接，结果是一个普通文件。
- **属主与权限**：rename 后的文件沿用新 inode 的默认权限，不复制原文件的 ACL/属性。
- **无跨文件事务**：一次保存只快照并写一个文件；多个文件的一致性由界面逐次调用保证。
- **只覆盖用户级配置**：不处理项目级 `.claude/settings.json`、`.codex/config.toml` 等仓库内文件。
- **Windows 重试是尽力而为**：重试仍失败时返回 500；快照会保留 `[失败]` 标记。
- **GET 不设大小上限**：只读注册表内的固定文件；`~/.claude.json` 可能很大，读取是同步的。
- **密钥明文**：GET 返回真实值，不脱敏；本服务只监听 loopback，且写请求有 Host/Origin 检查。
