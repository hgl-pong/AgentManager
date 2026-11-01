# Hooks backend implementation and acceptance

## Ownership and contract

Changed only `server/hooks.ts`, `server/hooks.test.ts`, `server/app.ts` and this report. Existing edits to `shared/types.ts` and concurrent frontend edits were preserved; no dependencies or shared contract changes, no git commit/stash/reset/checkout.

The source is `<home>/.agents/hooks/hooks.json`, version 1 with event → agent → matcher-group arrays. Definitions remain agent-specific: importing Claude does not manufacture a Codex definition. `prefer` is retained in the shared request type for compatibility but intentionally unused: importAll always retains an existing per-agent source definition, as the task requires.

## Implementation

- `server/hooks.ts`: `readSource` treats missing files as an empty source and reports malformed JSON, non-object roots and invalid source structures as `source.error`; every action refuses an unreadable source with HTTP 400. Source data must contain version 1 and a hooks object. Saving the source owns only `version` and `hooks`: any other top-level keys the file already carries are kept as-is.
- `validateDefinitions` / `eventName`: case-sensitive Claude/Codex event union, per-agent handler types and required nonempty command/url/server/tool, matcher/group/handler structure. Unknown source agent keys are rejected.
- `buildHooksReport`: source-first alphabetical event rows; all three agent cells; per-agent unsupported/none/orphan/missing/synced/drift states; empty-array absence semantics; structural equality ignoring object-key order; known event suggestions and disabled Codex feature warning.
- `summary`: group/handler counts and type/command excerpts, masking credential flags, common token prefixes, bearer credentials, URL userinfo and token query values. Raw definitions remain unmasked for editing; summaries omit headers/URLs/payload fields.
- `runHooksAction`: import, importAll with preserved conflicting definitions and warnings, saveSource with optional sync, deleteSource, selective/all sync, remove. A missing definition never copies another agent's array. Empty source arrays delete target event keys. Unsupported events are skipped with warnings; pi cannot be written.
- Each changed target file is written once per action, even for multi-event sync. Unchanged targets need no snapshot/write. Codex sync includes the `/hooks` re-trust warning (including already-synced applicable definitions); changed Codex remove also warns.
- Claude reads/writes use registered `claude-settings`, full-file data and etag via `readSettings`/`saveSettings`. Codex hooks use their independent JSON document, preserving other root keys. No Codex config.toml/trust hash writes occur.
- Source and Codex writes reuse `writeAtomically` (sibling temporary file + rename), canonical two-space JSON with terminal newline, pre-write snapshots and created-file registration. Failed writes mark their snapshot failed. Multi-file actions are sequential, not filesystem transactions; snapshots permit rollback of completed writes if a later I/O write fails.
- `server/app.ts`: adds `hooksSource`/`codexHooks` to AppConfig, open whitelist and snapshot restore roots; GET/POST `/api/hooks` uses live reports, existing local-write protection and serialized write queue.

## Required acceptance cases → test names

All tests use isolated temporary homes and remove them afterward.

1. Missing source / orphans / pi unsupported → `missing source: Claude/Codex hooks are orphan; pi unsupported; summaries redact tokens`.
2. Claude import → `import Claude builds per-agent source; Claude synced, Codex none until defined` (Codex is none without its own source definition, per matrix rules).
3. Codex sync / root preservation / trust warning → `sync Codex preserves root keys, reports missing then synced and /hooks warning`.
4. External drift / restoration / key-order-insensitive comparison → `external modifications drift; sync restores; object key order does not drift`.
5. Save both definitions and synchronize exact arrays → `saveSource syncs both arrays and preserves other Claude settings; missing Codex created`.
6. importAll / conflict preservation / single source write → `importAll imports both agents once and preserves conflicting source definitions`.
7. Delete source / remove target / empty definitions → `deleteSource leaves orphan; remove produces none or missing; empty definitions delete event`.
8. Unsupported Codex event / skip warning → `unsupported Codex events stay unsupported and sync skips with warning`.
9. Empty array deletes target key → `empty source array deletes target event and missing/empty targets are synced`.
10. Handler and unknown-event HTTP-400 validation → `handler validation rejects malformed groups/types/required fields and unknown events`; API test also verifies HTTP 400.
11. Snapshot restore / created-path removal → `snapshots restore source import, existing sync and created Codex files`; API test restores through HTTP allowlisted roots.
12. Invalid JSON / non-object root / invalid source schema → `damaged source JSON, non-object roots and invalid definitions report error and reject all writes`.
13. Preserve other Claude keys / create absent Codex file → test 5 above.
14. GET shape / all agent metadata / event suggestions → `GET/POST hooks API shape, known events, local write protection, whitelist and restore`.

Additional tests:
- `multi-event sync writes each changed file once; disabled Codex warning; source rows first`.
- `invalid target JSON refuses writes without replacing content or partially saving source`.
- `valid handler types round-trip; absent agent definitions never copy another agent`.
- `command summaries mask bearer credentials, URL credentials and query tokens`.

## Verification

- `node --test server/hooks.test.ts`: 17 passed, 0 failed.
- `npm test`: final run 146 passed, 0 failed (including all 17 hooks tests).
- `npx tsc --noEmit`: zero diagnostics in owned backend files. Latest observed diagnostics were solely in concurrently edited `web/src/views/HooksView.tsx` (missing useRef argument at line 31 and fallback cell union lacking optional summary/error fields at line 48); coordinator notified and frontend worker owns resolution.

## Contract deviations and limitations

No shared API contract deviations. `prefer` has no effect for the task's explicitly non-overwriting per-agent importAll policy. Invalid existing agent files are surfaced in cell errors and rejected when targeted; the shared HookState contract has no invalid state. Reports only include events present in the source or actual agent files; the full known event union is separately available in `events`. Unknown source versions/schema are rejected rather than silently repaired. No real user-home files were touched and no hook commands were executed.
