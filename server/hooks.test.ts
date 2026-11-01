import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { AppError } from '../shared/types.ts';
import type { HookActionRequest, HookMatrixReport } from '../shared/types.ts';
import { createAppConfig, startAgentServer } from './app.ts';
import { buildHooksReport, runHooksAction } from './hooks.ts';
import { restoreSnapshot } from './snapshot.ts';

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'agent-manager-hooks-'));
  roots.push(root);
  const config = createAppConfig({ projectRoot: root, home: join(root, 'home'), dataDir: join(root, 'data') });
  const input = { sourcePath: config.hooksSource, codexHooks: config.codexHooks, snapshotRoot: config.snapshotRoot, settingsFiles: config.settingsFiles };
  const claude = join(config.home, '.claude', 'settings.json');
  const act = (request: HookActionRequest) => runHooksAction(input, request);
  return { config, input, claude, codex: config.codexHooks, source: config.hooksSource, act,
    report: () => buildHooksReport(input) };
}
function write(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function read(path: string): Record<string, any> { return JSON.parse(readFileSync(path, 'utf8')); }
function row(report: HookMatrixReport, event = 'PreToolUse') {
  const value = report.rows.find((item) => item.event === event);
  assert.ok(value, `missing ${event}`);
  return value;
}
function bad(action: () => unknown) {
  assert.throws(action, (error: unknown) => error instanceof AppError && error.status === 400);
}
const COMMAND = [{ matcher: '*', hooks: [{ type: 'command', command: 'node check.js --token private-value' }] }];
const OTHER = [{ hooks: [{ type: 'prompt', prompt: 'Check' }] }];

test('missing source: Claude/Codex hooks are orphan; pi unsupported; summaries redact tokens', () => {
  const e = fresh();
  write(e.claude, { hooks: { PreToolUse: COMMAND } });
  write(e.codex, { hooks: { PreToolUse: COMMAND } });
  assert.equal(e.report().source.exists, false);
  const cells = row(e.report()).cells;
  assert.equal(cells.claude?.state, 'orphan');
  assert.equal(cells.codex?.state, 'orphan');
  assert.equal(cells.pi?.state, 'unsupported');
  assert.match(cells.claude!.summary!, /1 组 \/ 1 handlers/);
  assert.ok(!cells.claude!.summary!.includes('private-value'));
});

test('import Claude builds per-agent source; Claude synced, Codex none until defined', () => {
  const e = fresh();
  write(e.claude, { hooks: { PreToolUse: COMMAND } });
  const result = e.act({ action: 'import', event: 'PreToolUse', agent: 'claude' });
  assert.deepEqual(read(e.source), { version: 1, hooks: { PreToolUse: { claude: COMMAND } } });
  assert.equal(row(result.report).cells.claude?.state, 'synced');
  assert.equal(row(result.report).cells.codex?.state, 'none');
  assert.equal(result.snapshotIds.length, 1);
  assert.ok(readFileSync(e.source, 'utf8').endsWith('\n'));
});

test('saving the source keeps top-level keys the file already has', () => {
  const e = fresh();
  write(e.source, { version: 1, note: 'keep me', hooks: {} });
  e.act({ action: 'saveSource', event: 'PreToolUse', definitions: { claude: COMMAND } });
  assert.deepEqual(read(e.source), { version: 1, note: 'keep me', hooks: { PreToolUse: { claude: COMMAND } } });
});

test('sync Codex preserves root keys, reports missing then synced and /hooks warning', () => {
  const e = fresh();
  write(e.codex, { metadata: { keep: true } });
  e.act({ action: 'saveSource', event: 'PreToolUse', definitions: { codex: COMMAND } });
  assert.equal(row(e.report()).cells.codex?.state, 'missing');
  const result = e.act({ action: 'sync', agents: ['codex'] });
  assert.deepEqual(read(e.codex), { metadata: { keep: true }, hooks: { PreToolUse: COMMAND } });
  assert.equal(row(result.report).cells.codex?.state, 'synced');
  assert.ok(result.warnings.some((warning) => warning.includes('/hooks')));
});

test('external modifications drift; sync restores; object key order does not drift', () => {
  const e = fresh();
  e.act({ action: 'saveSource', event: 'PreToolUse', definitions: { claude: COMMAND }, agents: ['claude'] });
  write(e.claude, { hooks: { PreToolUse: OTHER } });
  assert.equal(row(e.report()).cells.claude?.state, 'drift');
  e.act({ action: 'sync' });
  assert.equal(row(e.report()).cells.claude?.state, 'synced');
  write(e.claude, { hooks: { PreToolUse: [{ hooks: [{ command: COMMAND[0]!.hooks[0]!.command, type: 'command' }], matcher: '*' }] } });
  assert.equal(row(e.report()).cells.claude?.state, 'synced');
});

test('saveSource syncs both arrays and preserves other Claude settings; missing Codex created', () => {
  const e = fresh();
  write(e.claude, { model: 'keep-model', env: { HELLO: 'world' } });
  const result = e.act({ action: 'saveSource', event: 'PreToolUse', definitions: { claude: COMMAND, codex: OTHER }, agents: ['claude', 'codex'] });
  assert.deepEqual(read(e.source).hooks.PreToolUse, { claude: COMMAND, codex: OTHER });
  assert.deepEqual(read(e.claude), { model: 'keep-model', env: { HELLO: 'world' }, hooks: { PreToolUse: COMMAND } });
  assert.deepEqual(read(e.codex), { hooks: { PreToolUse: OTHER } });
  assert.equal(result.snapshotIds.length, 3);
  for (const agent of ['claude', 'codex']) assert.equal(row(result.report).cells[agent]?.state, 'synced');
});

test('importAll imports both agents once and preserves conflicting source definitions', () => {
  const e = fresh();
  e.act({ action: 'saveSource', event: 'PreToolUse', definitions: { claude: OTHER } });
  write(e.claude, { hooks: { PreToolUse: COMMAND, Stop: OTHER } });
  write(e.codex, { hooks: { PreToolUse: COMMAND } });
  const result = e.act({ action: 'importAll' });
  assert.equal(result.snapshotIds.length, 1);
  assert.ok(result.warnings.some((warning) => warning.includes('冲突')));
  assert.deepEqual(read(e.source).hooks, { PreToolUse: { claude: OTHER, codex: COMMAND }, Stop: { claude: OTHER } });
});

test('deleteSource leaves orphan; remove produces none or missing; empty definitions delete event', () => {
  const e = fresh();
  e.act({ action: 'saveSource', event: 'PreToolUse', definitions: { claude: COMMAND, codex: COMMAND }, agents: ['claude', 'codex'] });
  e.act({ action: 'deleteSource', event: 'PreToolUse' });
  assert.equal(row(e.report()).cells.claude?.state, 'orphan');
  e.act({ action: 'remove', event: 'PreToolUse', agent: 'claude' });
  assert.equal(row(e.report()).cells.claude?.state, 'none');
  e.act({ action: 'saveSource', event: 'PreToolUse', definitions: { codex: COMMAND } });
  e.act({ action: 'remove', event: 'PreToolUse', agent: 'codex' });
  assert.equal(row(e.report()).cells.codex?.state, 'missing');
  e.act({ action: 'saveSource', event: 'PreToolUse', definitions: {} });
  assert.equal(e.report().source.eventCount, 0);
});

test('unsupported Codex events stay unsupported and sync skips with warning', () => {
  const e = fresh();
  e.act({ action: 'saveSource', event: 'Setup', definitions: { codex: COMMAND } });
  const result = e.act({ action: 'sync', agents: ['codex'] });
  assert.equal(row(result.report, 'Setup').cells.codex?.state, 'unsupported');
  assert.ok(result.warnings.some((warning) => warning.includes('不支持 Setup')));
  assert.equal(existsSync(e.codex), false);
});

test('empty source array deletes target event and missing/empty targets are synced', () => {
  const e = fresh();
  write(e.codex, { hooks: { PreToolUse: COMMAND, Stop: OTHER } });
  e.act({ action: 'saveSource', event: 'PreToolUse', definitions: { codex: [] } });
  assert.equal(row(e.report()).cells.codex?.state, 'drift');
  e.act({ action: 'sync' });
  assert.deepEqual(read(e.codex).hooks, { Stop: OTHER });
  assert.equal(row(e.report()).cells.codex?.state, 'synced');
  write(e.codex, { hooks: { PreToolUse: [] } });
  assert.equal(row(e.report()).cells.codex?.state, 'synced');
});

test('handler validation rejects malformed groups/types/required fields and unknown events', () => {
  const e = fresh();
  const invalid = [
    { claude: [{ hooks: [{ type: 'command' }] }] },
    { codex: [{ hooks: [{ type: 'http', url: 'https://example.test' }] }] },
    { claude: [{ hooks: [{ type: 'http' }] }] },
    { claude: [{ hooks: [{ type: 'mcp_tool', server: 's' }] }] },
    { claude: [{ matcher: 1, hooks: [] }] }, { claude: [null] },
    { claude: [{ hooks: [null] }] }, { pi: [] }, { claude: {} },
  ];
  for (const definitions of invalid) bad(() => e.act({ action: 'saveSource', event: 'PreToolUse', definitions: definitions as unknown as Record<string, unknown[]> }));
  bad(() => e.act({ action: 'saveSource', event: 'pretooluse', definitions: {} }));
  assert.equal(existsSync(e.source), false);
});

test('snapshots restore source import, existing sync and created Codex files', () => {
  const e = fresh();
  write(e.claude, { hooks: { PreToolUse: COMMAND } });
  const imported = e.act({ action: 'import', event: 'PreToolUse', agent: 'claude' });
  const allowed = [e.source, e.claude, e.codex];
  restoreSnapshot(e.input.snapshotRoot, imported.snapshotIds[0]!, allowed);
  assert.equal(existsSync(e.source), false);
  e.act({ action: 'saveSource', event: 'PreToolUse', definitions: { claude: OTHER, codex: OTHER } });
  const synced = e.act({ action: 'sync' });
  assert.equal(synced.snapshotIds.length, 2);
  for (const id of synced.snapshotIds) restoreSnapshot(e.input.snapshotRoot, id, allowed);
  assert.deepEqual(read(e.claude).hooks.PreToolUse, COMMAND);
  assert.equal(existsSync(e.codex), false);
});

test('damaged source JSON, non-object roots and invalid definitions report error and reject all writes', () => {
  const e = fresh();
  for (const content of ['{', '[]', '{"version":1,"hooks":{"Stop":{"pi":[]}}}']) {
    mkdirSync(dirname(e.source), { recursive: true });
    writeFileSync(e.source, content);
    assert.ok(e.report().source.error);
    for (const action of ['sync', 'importAll', 'deleteSource', 'remove'] as const) bad(() => e.act({ action, event: 'Stop', agent: 'claude' }));
    assert.equal(readFileSync(e.source, 'utf8'), content);
  }
});

test('multi-event sync writes each changed file once; disabled Codex warning; source rows first', () => {
  const e = fresh();
  const config = join(e.config.home, '.codex', 'config.toml');
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, '[features]\nhooks = false\n');
  write(e.codex, { hooks: { Interrupt: COMMAND } });
  for (const event of ['Stop', 'SessionStart']) e.act({ action: 'saveSource', event, definitions: { codex: COMMAND } });
  const result = e.act({ action: 'sync' });
  assert.equal(result.snapshotIds.length, 1);
  assert.match(result.report.warnings!.join(), /被禁用/);
  assert.deepEqual(result.report.rows.map((item) => item.event), ['SessionStart', 'Stop', 'Interrupt']);
  assert.equal(e.act({ action: 'sync' }).snapshotIds.length, 0);
});

test('invalid target JSON refuses writes without replacing content or partially saving source', () => {
  const e = fresh();
  mkdirSync(dirname(e.codex), { recursive: true });
  writeFileSync(e.codex, '{');
  bad(() => e.act({ action: 'saveSource', event: 'Stop', definitions: { codex: COMMAND }, agents: ['codex'] }));
  assert.equal(existsSync(e.source), false);
  assert.equal(readFileSync(e.codex, 'utf8'), '{');
});

test('valid handler types round-trip; absent agent definitions never copy another agent', () => {
  const e = fresh();
  const groups = [{ hooks: [
    { type: 'http', url: 'https://example.test', headers: { token: 'keep-private' } },
    { type: 'mcp_tool', server: 'tools', tool: 'check' },
    { type: 'agent', prompt: 'Check' },
  ] }];
  e.act({ action: 'saveSource', event: 'Stop', definitions: { claude: groups }, agents: ['claude', 'codex'] });
  assert.deepEqual(read(e.claude).hooks.Stop, groups);
  assert.equal(existsSync(e.codex), false);
  assert.equal(row(e.report(), 'Stop').cells.codex?.state, 'none');
  assert.ok(!row(e.report(), 'Stop').cells.claude?.summary?.includes('keep-private'));
});

test('command summaries mask bearer credentials, URL credentials and query tokens', () => {
  const e = fresh();
  write(e.claude, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'curl https://user:private-pass@example.test/?token=private-query -H "Authorization: Bearer private-bearer"' }] }] } });
  const summary = row(e.report(), 'Stop').cells.claude!.summary!;
  for (const secret of ['private-pass', 'private-query', 'private-bearer']) assert.ok(!summary.includes(secret));
});

test('GET/POST hooks API shape, known events, local write protection, whitelist and restore', async () => {
  const e = fresh();
  const hooks = { port: 0, startedAt: new Date().toISOString() };
  const app = await startAgentServer(e.config, hooks);
  hooks.port = (app.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${hooks.port}`;
  const post = (path: string, data: unknown, origin?: string) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(data) });
  try {
    const response = await fetch(`${base}/api/hooks`);
    assert.equal(response.status, 200);
    const report = await response.json() as HookMatrixReport;
    assert.equal(report.source.path, e.source);
    assert.equal(report.agents.length, 3);
    assert.deepEqual(report.rows, []);
    for (const event of ['Setup', 'StopFailure', 'Interrupt', 'PreModelRequest', 'PostModelRequest']) assert.ok(report.events.includes(event));
    assert.ok(!Number.isNaN(Date.parse(report.scannedAt)));
    assert.ok(e.config.openable.has(e.source.toLowerCase()));
    assert.ok(e.config.openable.has(e.codex.toLowerCase()));
    assert.equal((await post('/api/hooks', { action: 'sync' }, 'https://evil.test')).status, 403);
    assert.equal((await post('/api/hooks', { action: 'saveSource', event: 'Nope', definitions: {} })).status, 400);
    const saved = await post('/api/hooks', { action: 'saveSource', event: 'Stop', definitions: { codex: COMMAND }, agents: ['codex'] });
    assert.equal(saved.status, 200);
    const result = await saved.json() as { snapshotIds: string[] };
    for (const id of result.snapshotIds) assert.equal((await post('/api/snapshots/restore', { id })).status, 200);
    assert.equal(existsSync(e.source), false);
    assert.equal(existsSync(e.codex), false);
  } finally { await app.close(); }
});
