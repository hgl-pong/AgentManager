import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { parse as parseToml } from 'smol-toml';

import { AppError } from '../shared/types.ts';
import { createSettingsRegistry, readSettings, saveSettings } from './settings.ts';
import { restoreSnapshot } from './snapshot.ts';

import type { SettingsFileDescriptor, SettingsFileState, SettingsSaveResult } from '../shared/types.ts';

let root: string;
let home: string;
let snapshotRoot: string;
let registry: SettingsFileDescriptor[];

before(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-manager-settings-'));
  home = join(root, 'home');
  snapshotRoot = join(root, 'snapshots');
  mkdirSync(home, { recursive: true });
  registry = createSettingsRegistry({ home });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function descriptor(id: string): SettingsFileDescriptor {
  const found = registry.find((file) => file.id === id);
  if (!found) throw new Error(`unknown test file id: ${id}`);
  return found;
}

function stateOf(id: string): SettingsFileState {
  for (const agent of readSettings(registry).agents) {
    const found = agent.files.find((file) => file.id === id);
    if (found) return found;
  }
  throw new Error(`settings report is missing ${id}`);
}

function save(id: string, body: Record<string, unknown>, etag: string = stateOf(id).etag): SettingsSaveResult {
  return saveSettings({
    files: registry,
    snapshotRoot,
    request: { fileId: id, etag, ...body },
  });
}

function expectStatus(status: number, action: () => unknown): AppError {
  try {
    action();
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    assert.equal(error.status, status);
    return error;
  }
  assert.fail(`expected AppError ${status}, but the call succeeded`);
}

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

test('the registry derives every host path from the fake home', () => {
  assert.deepEqual(
    registry.map((file) => file.id),
    ['claude-settings', 'claude-mcp', 'codex-config', 'pi-settings', 'pi-mcp'],
  );
  assert.equal(descriptor('claude-settings').path, join(home, '.claude', 'settings.json'));
  assert.equal(descriptor('claude-settings').scope, 'full');
  assert.equal(descriptor('claude-mcp').path, join(home, '.claude.json'));
  assert.equal(descriptor('claude-mcp').hostPath, join(home, '.claude.json'));
  assert.equal(descriptor('claude-mcp').scope, 'mcp');
  assert.equal(descriptor('claude-mcp').mcpKey, 'mcpServers');
  assert.equal(descriptor('codex-config').format, 'toml');
  assert.equal(descriptor('codex-config').mcpKey, 'mcp_servers');
  assert.equal(descriptor('pi-mcp').scope, 'full');
  assert.equal(descriptor('pi-mcp').mcpKey, 'mcpServers');
  for (const file of registry) assert.ok(file.path.startsWith(home));
});

test('a JSON full file keeps unknown keys and never invents unset ones', () => {
  const path = descriptor('claude-settings').path;
  mkdirSync(dirname(path), { recursive: true });
  const original = { model: 'sonnet', customTop: { keep: true } };
  writeFileSync(path, `${JSON.stringify(original, null, 2)}\n`);

  const state = stateOf('claude-settings');
  assert.equal(state.exists, true);
  assert.deepEqual(state.data, original);
  assert.equal(state.text, `${JSON.stringify(original, null, 2)}\n`);
  assert.equal(state.etag, hash(readFileSync(path, 'utf8')));

  const saved = save('claude-settings', { data: { model: 'opus', customTop: { keep: true } } });
  assert.equal((saved.file.data as Record<string, unknown>).model, 'opus');
  const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(written, { model: 'opus', customTop: { keep: true } });
  assert.equal('effortLevel' in written, false);
});

test('a TOML file round-trips unknown keys and converts dates for the browser', () => {
  const path = descriptor('codex-config').path;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      'model = "gpt-5"',
      'when = 2024-01-02T03:04:05Z',
      '',
      '[custom]',
      'note = "kept"',
      '',
      '[mcp_servers.shared]',
      'command = "node"',
      'args = ["s.js"]',
      '',
    ].join('\n'),
  );

  const state = stateOf('codex-config');
  const data = state.data as Record<string, Record<string, unknown>>;
  assert.equal(data.model, 'gpt-5');
  assert.equal((data.custom as Record<string, unknown>).note, 'kept');
  assert.equal(typeof data.when, 'string');
  assert.match(String(data.when), /^2024-01-02T03:04:05/);
  assert.match(state.text ?? '', /when = 2024-01-02T03:04:05/);

  save('codex-config', {
    data: {
      model: 'gpt-6',
      custom: { note: 'kept' },
      extraUnknown: { enabled: true },
      mcp_servers: { shared: { command: 'node', args: ['s.js'] } },
    },
  });

  const written = parseToml(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>;
  assert.equal(written.model, 'gpt-6');
  assert.deepEqual(JSON.parse(JSON.stringify(written.custom)), { note: 'kept' });
  assert.deepEqual(JSON.parse(JSON.stringify(written.extraUnknown)), { enabled: true });
  assert.deepEqual(JSON.parse(JSON.stringify(written.mcp_servers)), {
    shared: { command: 'node', args: ['s.js'] },
  });
});

test('a stale etag refuses to overwrite an externally changed file', () => {
  const path = descriptor('claude-settings').path;
  const stale = stateOf('claude-settings');
  writeFileSync(path, '{"model":"external"}\n');

  expectStatus(409, () => save('claude-settings', { data: { model: 'mine' } }, stale.etag));
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { model: 'external' });

  const saved = save('claude-settings', { data: { model: 'mine' } });
  assert.equal((saved.file.data as Record<string, unknown>).model, 'mine');

  const piPath = descriptor('pi-settings').path;
  mkdirSync(dirname(piPath), { recursive: true });
  assert.equal(stateOf('pi-settings').etag, 'missing');
  writeFileSync(piPath, '{"defaultModel":"external"}\n');
  expectStatus(409, () => save('pi-settings', { data: { defaultModel: 'mine' } }, 'missing'));
  assert.deepEqual(JSON.parse(readFileSync(piPath, 'utf8')), { defaultModel: 'external' });
});

test('saving a missing file creates it and the snapshot restores its absence', () => {
  const path = descriptor('pi-mcp').path;
  assert.equal(existsSync(path), false);
  assert.equal(stateOf('pi-mcp').etag, 'missing');

  const saved = save('pi-mcp', { data: { mcpServers: { local: { command: 'node' } } } }, 'missing');
  assert.equal(existsSync(path), true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { mcpServers: { local: { command: 'node' } } });
  assert.equal(saved.file.exists, true);
  assert.equal(saved.file.etag, hash(readFileSync(path, 'utf8')));

  restoreSnapshot(snapshotRoot, saved.snapshotId, [path]);
  assert.equal(existsSync(path), false);
});

test('known fields are validated by type, enum and bounds while unknown keys pass', () => {
  const path = descriptor('claude-settings').path;
  writeFileSync(path, '{"model":"sonnet"}\n');
  const etag = stateOf('claude-settings').etag;

  const invalid: Array<Record<string, unknown>> = [
    { model: 1 },
    { fastMode: 'yes' },
    { cleanupPeriodDays: 1.5 },
    { cleanupPeriodDays: 0 },
    { skillListingBudgetFraction: 2 },
    { effortLevel: 'max' },
    { availableModels: [1] },
    { env: { A: 1 } },
  ];
  for (const data of invalid) expectStatus(400, () => save('claude-settings', { data }, etag));
  assert.equal(readFileSync(path, 'utf8'), '{"model":"sonnet"}\n');

  const saved = save(
    'claude-settings',
    {
      data: {
        model: 'sonnet',
        cleanupPeriodDays: 7,
        effortLevel: 'xhigh',
        unknownTop: { any: ['json', 1, true] },
      },
    },
    etag,
  );
  assert.deepEqual((saved.file.data as Record<string, unknown>).unknownTop, { any: ['json', 1, true] });

  const piPath = descriptor('pi-settings').path;
  writeFileSync(piPath, '{"defaultModel":"x"}\n');
  const piEtag = stateOf('pi-settings').etag;
  expectStatus(400, () => save('pi-settings', { data: { warnings: { anthropicExtraUsage: 'yes' } } }, piEtag));
  save('pi-settings', { data: { warnings: { anthropicExtraUsage: true } } }, piEtag);
});

test('MCP servers are validated for transport, args and string maps', () => {
  const path = descriptor('claude-mcp').path;
  assert.equal(existsSync(path), false);
  const etag = stateOf('claude-mcp').etag;

  const invalid: Array<Record<string, unknown>> = [
    { plain: {} },
    { s: { type: 'stdio' } },
    { s: { type: 'http' } },
    { s: { type: 'sse' } },
    { s: { command: 'x', args: [1] } },
    { s: { command: 'x', env: { A: 1 } } },
    { s: { url: 'https://example.com/mcp', headers: { A: 1 } } },
    { 'a/b': { command: 'x' } },
    { '': { command: 'x' } },
  ];
  for (const data of invalid) expectStatus(400, () => save('claude-mcp', { data }, etag));
  assert.equal(existsSync(path), false);

  const saved = save(
    'claude-mcp',
    {
      data: {
        remote: { type: 'http', url: 'https://example.com/mcp' },
        local: { type: 'stdio', command: 'node', args: ['s.js'], env: { K: 'v' } },
      },
    },
    etag,
  );
  assert.deepEqual((saved.file.data as Record<string, unknown>).remote, {
    type: 'http',
    url: 'https://example.com/mcp',
  });
});

test('the Claude MCP file only changes mcpServers and drops it when the map is empty', () => {
  const path = descriptor('claude-mcp').path;
  const original = { projects: { demo: { trusted: true } }, theme: 'dark', mcpServers: { old: { command: 'old' } } };
  writeFileSync(path, `${JSON.stringify(original, null, 2)}\n`);

  const state = stateOf('claude-mcp');
  assert.deepEqual(state.data, { old: { command: 'old' } });
  assert.equal(state.text, `${JSON.stringify({ old: { command: 'old' } }, null, 2)}\n`);

  const saved = save('claude-mcp', { data: { fresh: { command: 'fresh' } } });
  let host = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(host.projects, original.projects);
  assert.equal(host.theme, 'dark');
  assert.deepEqual(host.mcpServers, { fresh: { command: 'fresh' } });
  assert.deepEqual(saved.file.data, { fresh: { command: 'fresh' } });

  save('claude-mcp', { text: '{"raw":{"command":"raw"}}' });
  host = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(host.projects, original.projects);
  assert.equal(host.theme, 'dark');
  assert.deepEqual(host.mcpServers, { raw: { command: 'raw' } });

  save('claude-mcp', { data: {} });
  host = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  assert.equal('mcpServers' in host, false);
  assert.deepEqual(host.projects, original.projects);
  assert.equal(host.theme, 'dark');
});

test('raw text mode parses before writing and leaves invalid content untouched', () => {
  const claudePath = descriptor('claude-settings').path;
  writeFileSync(claudePath, '{"model":"base"}\n');
  let etag = stateOf('claude-settings').etag;

  expectStatus(400, () => save('claude-settings', { text: '{ nope' }, etag));
  assert.equal(readFileSync(claudePath, 'utf8'), '{"model":"base"}\n');

  const saved = save('claude-settings', { text: '{"model":"raw","custom":true}' }, etag);
  assert.equal(readFileSync(claudePath, 'utf8'), '{"model":"raw","custom":true}\n');
  assert.deepEqual(saved.file.data, { model: 'raw', custom: true });

  etag = saved.file.etag;
  expectStatus(400, () => save('claude-settings', { text: '{"model":42}' }, etag));
  assert.equal(readFileSync(claudePath, 'utf8'), '{"model":"raw","custom":true}\n');

  const codexPath = descriptor('codex-config').path;
  writeFileSync(codexPath, 'model = "old"\n');
  etag = stateOf('codex-config').etag;
  expectStatus(400, () => save('codex-config', { text: 'model = ' }, etag));
  assert.equal(readFileSync(codexPath, 'utf8'), 'model = "old"\n');

  const toml = save('codex-config', { text: 'model = "new"\n[extra]\nnote = "keep"\n' }, etag);
  assert.equal(readFileSync(codexPath, 'utf8'), 'model = "new"\n[extra]\nnote = "keep"\n');
  assert.equal(((toml.file.data as Record<string, Record<string, unknown>>).extra as Record<string, unknown>).note, 'keep');
});

test('unknown file ids and traversal-shaped ids are rejected', () => {
  const outside = join(root, 'outside.json');
  writeFileSync(outside, '{"secret":true}\n');

  for (const fileId of ['nope', '../outside.json', outside, '..\\..\\outside.json']) {
    expectStatus(404, () =>
      saveSettings({ files: registry, snapshotRoot, request: { fileId, etag: 'missing', data: { model: 'x' } } }),
    );
  }
  assert.equal(readFileSync(outside, 'utf8'), '{"secret":true}\n');
});

test('a save changes the etag and the next read sees the new value', () => {
  const path = descriptor('pi-settings').path;
  writeFileSync(path, '{"defaultModel":"one"}\n');
  const before = stateOf('pi-settings');

  const saved = save('pi-settings', { data: { defaultModel: 'two' } });
  assert.notEqual(saved.file.etag, before.etag);

  const after = stateOf('pi-settings');
  assert.equal(after.etag, saved.file.etag);
  assert.equal((after.data as Record<string, unknown>).defaultModel, 'two');
  assert.equal(after.bytes, Buffer.byteLength(readFileSync(path, 'utf8')));
});

test('a broken host file is reported through parseError instead of throwing', () => {
  const path = descriptor('pi-settings').path;
  writeFileSync(path, '{not json');
  const state = stateOf('pi-settings');

  assert.equal(state.exists, true);
  assert.ok(state.parseError);
  assert.equal(state.data, undefined);
  assert.equal(state.text, undefined);
  assert.match(state.etag, /^[a-f0-9]{64}$/);
});

test('a TOML structured save accepts tables declared before scalars', () => {
  const path = descriptor('codex-config').path;
  writeFileSync(path, 'model = "old"\n');
  const etag = stateOf('codex-config').etag;

  // smol-toml emits scalars first, so a key-order-sensitive round-trip check would reject this.
  const saved = save('codex-config', { data: { table: { nested: true }, model: 'gpt-6' } }, etag);
  assert.equal((saved.file.data as Record<string, unknown>).model, 'gpt-6');
  const written = parseToml(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>;
  assert.equal(written.model, 'gpt-6');
  assert.equal(written.table?.nested, true);
});

test('a raw TOML save that cannot round-trip is rejected before writing', () => {
  const path = descriptor('codex-config').path;
  writeFileSync(path, 'model = "keep"\n');
  const etag = stateOf('codex-config').etag;

  // TOML has no null: serialized data would read back differently, so the save must be refused.
  expectStatus(400, () => save('codex-config', { data: { model: 'x', broken: null } }, etag));
  assert.equal(readFileSync(path, 'utf8'), 'model = "keep"\n');
});
