# Vendored agent configuration schemas

`server/settings-catalog.ts` is generated from these files by
`npm run build:catalog` (`scripts/build-settings-catalog.mjs`). Do not edit the
generated catalog by hand.

| File | Agent | Source | Retrieved |
| --- | --- | --- | --- |
| `claude-settings.json` | Claude Code (`~/.claude/settings.json`) | https://json.schemastore.org/claude-code-settings.json | 2026-10-29 |
| `codex-config.json` | Codex (`~/.codex/config.toml`) | https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/config.schema.json | 2026-10-29 |
| `pi-settings.json` | pi (`~/.pi/agent/settings.json`) | https://pi.dev/schemas/settings.schema.json | 2026-10-29 |

The schemas are vendored so the app works offline and a schema change is a
reviewable diff. Update a file from its source, then run `npm run build:catalog`.
`build:exe` runs the generator automatically.

`descriptions.zh.json` holds the Simplified Chinese description for every
catalog field, keyed by `"<agent>:<dot.path>"` (for example
`"claude:permissions.allow"`). The generator merges it into the catalog and
reports coverage; fields without an override keep the schema's English text.
When a schema adds a key, add its Chinese description here.

Notes:

- Claude Code's user-scope MCP servers live in `~/.claude.json` under
  `mcpServers`, not in `settings.json`; this app writes only that subtree.
- Managed-settings-only keys are kept in the catalog for inspection but flagged
  `managedOnly`; writing them to a user file is a no-op.
- Keys that execute commands are flagged `executable` in the catalog and need an
  explicit confirmation in the UI before saving.
