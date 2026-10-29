import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { createAppConfig, safeMatrix, selectAsset } from './app.ts';
import { isInside } from './scan.ts';
import type {
  ConfigReport,
  MatrixResponse,
  PromptsReport,
  RestoreResponse,
  SettingsCatalog,
  SettingsFileState,
  SettingsReport,
  SettingsSaveResult,
  SnapshotManifest,
} from '../shared/types.ts';

// Picked per run: the launcher keeps state under its data dir, so another instance on the
// machine (or another worker's test run) can never make this suite reuse it.
let PORT = 0;
let BASE = '';

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

let home: string;
let server: ChildProcess;

function writeSkill(dir: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body);
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

async function postStatus(path: string, body: unknown, headers: Record<string, string> = {}): Promise<number> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  await response.arrayBuffer();
  return response.status;
}

/** Raw HTTP, because fetch refuses to forge the Host header the origin guard checks. */
function rawPost(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port: PORT, path, method: 'POST', headers },
      (response) => {
        response.resume();
        response.on('end', () => resolvePromise(response.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    request.end('{}');
  });
}

async function settingsFile(id: string): Promise<SettingsFileState> {
  const report = await call<SettingsReport>('/api/settings');
  for (const agent of report.agents) {
    const found = agent.files.find((file) => file.id === id);
    if (found) return found;
  }
  throw new Error(`settings report is missing ${id}`);
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'agent-manager-api-'));
  mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  mkdirSync(join(home, '.codex', 'skills'), { recursive: true });
  mkdirSync(join(home, '.pi', 'agent', 'skills'), { recursive: true });

  writeSkill(join(home, '.agents', 'skills', 'alpha'), 'alpha-v1');
  writeSkill(join(home, '.agents', 'skills', 'beta'), 'beta-v1');
  writeSkill(join(home, '.codex', 'skills', 'gamma'), 'gamma-v1');

  writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'claude prompt');
  writeFileSync(join(home, '.codex', 'AGENTS.md'), 'codex prompt');
  writeFileSync(join(home, '.pi', 'agent', 'AGENTS.md'), 'pi prompt');
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ model: 'sonnet', mcpServers: { shared: { command: 'npx', args: ['-y', 'pkg'] } } }),
  );
  writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.shared]\ncommand = "node"\nargs = ["s.js"]\n');
  writeFileSync(
    join(home, '.pi', 'agent', 'mcp.json'),
    JSON.stringify({ mcpServers: { shared: { command: 'pi-server' } } }),
  );

  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  // `--data` and `--no-window` keep the spawned launcher off the repo's state dir and off the
  // screen; without them a running instance would be reused and this suite would talk to it.
  server = spawn(
    process.execPath,
    ['server/index.ts', '--data', join(home, 'data'), '--port', String(PORT), '--no-window'],
    {
      env: { ...process.env, AGENT_MANAGER_HOME: home },
      stdio: 'ignore',
    },
  );

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await fetch(`${BASE}/api/matrix`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('server did not start');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
});

after(() => {
  server?.kill();
  rmSync(home, { recursive: true, force: true });
});

test('matrix reflects the fake home', async () => {
  const matrix = await call<MatrixResponse>('/api/matrix');
  const byName = Object.fromEntries(matrix.rows.map((row) => [row.name, row]));

  assert.deepEqual(matrix.source.skills, ['alpha', 'beta']);
  assert.equal(byName.alpha?.cells.claude?.state, 'missing');
  assert.equal(byName.gamma?.cells.codex?.state, 'orphan');
  assert.equal(byName.gamma?.inSource, false);
});

test('link creates a junction into the source', async () => {
  const result = await call<{ message: string; snapshotId: string; matrix: MatrixResponse }>('/api/skills', {
    agent: 'claude',
    action: 'link',
    name: 'alpha',
  });

  assert.match(result.message, /alpha/);
  assert.equal(realpathSync(join(home, '.claude', 'skills', 'alpha')), realpathSync(join(home, '.agents', 'skills', 'alpha')));
  assert.equal(result.matrix.rows.find((row) => row.name === 'alpha')?.cells.claude?.state, 'linked');

  const snapshots = await call<SnapshotManifest[]>('/api/snapshots');
  assert.ok(snapshots.some((snapshot) => snapshot.id === result.snapshotId));
});

test('import moves an orphan into the source and links back', async () => {
  await call('/api/skills', { agent: 'codex', action: 'import', name: 'gamma' });

  assert.equal(readFileSync(join(home, '.agents', 'skills', 'gamma', 'SKILL.md'), 'utf8'), 'gamma-v1');
  assert.equal(realpathSync(join(home, '.codex', 'skills', 'gamma')), realpathSync(join(home, '.agents', 'skills', 'gamma')));
});

test('remove drops a copy and the snapshot restores it', async () => {
  writeSkill(join(home, '.claude', 'skills', 'stale'), 'stale-v1');
  const result = await call<{ snapshotId: string }>('/api/skills', { agent: 'claude', action: 'remove', name: 'stale' });
  assert.equal(existsSync(join(home, '.claude', 'skills', 'stale')), false);

  await call('/api/snapshots/restore', { id: result.snapshotId });
  assert.equal(readFileSync(join(home, '.claude', 'skills', 'stale', 'SKILL.md'), 'utf8'), 'stale-v1');
});

test('actions reject unknown agents and unsafe names', async () => {
  await assert.rejects(() => call('/api/skills', { agent: 'nope', action: 'link', name: 'alpha' }), /未知的 agent/);
  await assert.rejects(() => call('/api/skills', { agent: 'claude', action: 'link', name: '../escape' }), /路径分隔符/);
});

test('errors answer with 400 for validation, 404 for absence and 409 for conflicts', async () => {
  assert.equal(await postStatus('/api/skills', { agent: 'nope', action: 'link', name: 'alpha' }), 400);
  assert.equal(await postStatus('/api/skills', { agent: 'claude', action: 'link', name: 'alpha' }), 409);
  assert.equal(await postStatus('/api/skills', { agent: 'claude', action: 'remove', name: 'nope' }), 404);
  assert.equal(await postStatus('/api/snapshots/restore', { id: 'nope' }), 404);
  assert.equal(await postStatus('/api/snapshots/restore', { id: '../outside' }), 400);
});

test('write endpoints reject a foreign Host, a cross-origin request and a non-JSON body', async () => {
  assert.equal(await rawPost('/api/skills', { host: 'evil.example', 'content-type': 'application/json' }), 403);
  assert.equal(
    await rawPost('/api/skills', {
      host: `127.0.0.1:${PORT}`,
      origin: 'http://evil.example',
      'content-type': 'application/json',
    }),
    403,
  );
  assert.equal(
    await rawPost('/api/skills', { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, 'content-type': 'text/plain' }),
    415,
  );
});

test('concurrent writes are serialized and every snapshot id is unique', async () => {
  const names = ['race-a', 'race-b', 'race-c'];
  for (const name of names) writeSkill(join(home, '.agents', 'skills', name), `${name}-v1`);

  const results = await Promise.all(
    names.map((name) => call<{ snapshotId: string }>('/api/skills', { agent: 'pi', action: 'link', name })),
  );

  const ids = results.map((result) => result.snapshotId);
  assert.equal(new Set(ids).size, ids.length);
  for (const name of names) {
    assert.equal(
      realpathSync(join(home, '.pi', 'agent', 'skills', name)),
      realpathSync(join(home, '.agents', 'skills', name)),
    );
  }
  const listed = await call<SnapshotManifest[]>('/api/snapshots');
  for (const id of ids) assert.ok(listed.some((snapshot) => snapshot.id === id));
});

test('prompts start without a source and init migrates CLAUDE.md', async () => {
  const before = await call<PromptsReport>('/api/prompts');
  assert.equal(before.source.exists, false);
  assert.equal(before.targets[0]?.state, 'no-source');

  const result = await call<{ report: PromptsReport; snapshotId: string }>('/api/prompts', { action: 'init' });
  assert.equal(result.report.source.exists, true);
  assert.deepEqual(result.report.targets.map((target) => target.state), ['synced', 'synced', 'synced']);
  assert.equal(readFileSync(join(home, '.agents', 'prompts', 'global.md'), 'utf8'), 'claude prompt');
  assert.equal(readFileSync(join(home, '.pi', 'agent', 'AGENTS.md'), 'utf8'), 'claude prompt');

  await call('/api/snapshots/restore', { id: result.snapshotId });
  assert.equal(existsSync(join(home, '.agents', 'prompts', 'global.md')), false);
  assert.equal(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8'), 'claude prompt');
  assert.equal(readFileSync(join(home, '.pi', 'agent', 'AGENTS.md'), 'utf8'), 'pi prompt');
});

test('an unknown prompt action is a 400 and writes nothing', async () => {
  const before = await call<SnapshotManifest[]>('/api/snapshots');
  assert.equal(await postStatus('/api/prompts', { action: 'destroy' }), 400);
  assert.equal(await postStatus('/api/prompts', { action: 'align' }), 400);
  const after = await call<SnapshotManifest[]>('/api/snapshots');
  assert.equal(after.length, before.length);
});

test('the source can be edited in place and rolled back without breaking hard links', async () => {
  const init = await call<{ snapshotId: string }>('/api/prompts', { action: 'init' });
  const content = await call<{ content: string; exists: boolean }>('/api/prompts/content');
  assert.equal(content.exists, true);
  assert.equal(content.content, 'claude prompt');

  const inodeBefore = statSync(join(home, '.claude', 'CLAUDE.md')).ino;
  const saved = await call<{ content: { content: string }; report: PromptsReport; snapshotId: string }>(
    '/api/prompts/content',
    { content: 'prompt v2' },
  );
  assert.equal(saved.content.content, 'prompt v2');
  assert.deepEqual(saved.report.targets.map((target) => target.state), ['synced', 'synced', 'synced']);
  assert.equal(readFileSync(join(home, '.pi', 'agent', 'AGENTS.md'), 'utf8'), 'prompt v2');
  assert.equal(statSync(join(home, '.claude', 'CLAUDE.md')).ino, inodeBefore);

  await call('/api/snapshots/restore', { id: saved.snapshotId });
  assert.equal(readFileSync(join(home, '.agents', 'prompts', 'global.md'), 'utf8'), 'claude prompt');
  assert.equal(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8'), 'claude prompt');
  assert.equal(statSync(join(home, '.claude', 'CLAUDE.md')).ino, inodeBefore);

  await call('/api/snapshots/restore', { id: init.snapshotId });
});

test('a restore can be undone through the snapshotId it returns', async () => {
  await call('/api/prompts', { action: 'init' });
  const file = join(home, '.agents', 'prompts', 'global.md');
  await call('/api/prompts/content', { content: 'v2' });
  const v3 = await call<{ snapshotId: string }>('/api/prompts/content', { content: 'v3' });

  const restore = await call<RestoreResponse>('/api/snapshots/restore', { id: v3.snapshotId });
  assert.equal(readFileSync(file, 'utf8'), 'v2');
  assert.ok(restore.snapshotId);

  await call('/api/snapshots/restore', { id: restore.snapshotId });
  assert.equal(readFileSync(file, 'utf8'), 'v3');
});

test('config merges JSON and TOML MCP servers', async () => {
  const report = await call<ConfigReport>('/api/config');
  const shared = report.servers.find((row) => row.name === 'shared');
  assert.equal(shared?.byAgent.claude?.[0]?.summary, 'npx -y pkg');
  assert.equal(shared?.byAgent.codex?.[0]?.summary, 'node s.js');
  assert.equal(shared?.byAgent.pi?.[0]?.summary, 'pi-server');
});

test('unlink removes a broken link through the API', async () => {
  const link = join(home, '.pi', 'agent', 'skills', 'ghost');
  symlinkSync(join(home, 'deleted-skill'), link, 'junction');
  assert.equal(lstatSync(link).isSymbolicLink(), true);

  const result = await call<{ message: string; snapshotId: string; matrix: MatrixResponse }>('/api/skills', {
    agent: 'pi',
    action: 'unlink',
    name: 'ghost',
  });

  assert.match(result.message, /ghost/);
  assert.throws(() => lstatSync(link));
  assert.equal(result.matrix.rows.find((row) => row.name === 'ghost'), undefined);
});

test('opening a path outside the allowlist is refused', async () => {
  await assert.rejects(() => call('/api/open', { path: 'C:\\Windows\\System32\\calc.exe' }), /白名单/);
});

test('a scan failure after a write still yields a usable matrix with a warning', () => {
  const brokenHome = mkdtempSync(join(tmpdir(), 'agent-manager-broken-'));
  try {
    mkdirSync(join(brokenHome, '.agents'), { recursive: true });
    // A file where the skills directory belongs makes readdirSync throw ENOTDIR.
    writeFileSync(join(brokenHome, '.agents', 'skills'), 'not a directory');
    const config = createAppConfig({ projectRoot: brokenHome, home: brokenHome });

    const matrix = safeMatrix(config);
    assert.deepEqual(matrix.source.skills, []);
    assert.deepEqual(matrix.rows, []);
    assert.ok(matrix.warning);
    assert.equal(matrix.agents.length, config.agents.length);
  } finally {
    rmSync(brokenHome, { recursive: true, force: true });
  }
});

test('embedded asset lookup ignores the prototype chain', () => {
  assert.equal(selectAsset({}, 'constructor'), null);
  const assets = { 'index.html': Buffer.from('hi').toString('base64'), 'app.js': 'x' };
  assert.equal(selectAsset(assets, 'constructor')?.key, 'index.html');
  assert.equal(selectAsset(assets, 'app.js')?.key, 'app.js');
  assert.equal(selectAsset({ 'app.js': 'x' }, 'toString'), null);
});

test('static containment resolves mixed slashes before comparing', (t) => {
  const dist = resolve(home, 'dist');
  assert.equal(isInside(resolve(dist, 'app.js'), dist), true);
  assert.equal(isInside(resolve(dist, '..', 'secret.txt'), dist), false);
  assert.equal(isInside(dist, dist), false);
  if (process.platform !== 'win32') {
    t.skip('backslash separator behaviour is Windows-specific');
    return;
  }
  assert.equal(isInside(resolve(dist, 'assets\\app.js'), dist), true);
  assert.equal(isInside(resolve(dist, '..\\secret.txt'), dist), false);
});

// ---- editable settings ----

test('the settings catalog and report expose every file without masking values', async () => {
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ model: 'sonnet', env: { ANTHROPIC_AUTH_TOKEN: 'secret-visible' } }),
  );

  const catalog = await call<SettingsCatalog>('/api/settings/catalog');
  assert.deepEqual(catalog.agents.map((agent) => agent.key), ['claude', 'codex', 'pi']);
  assert.equal(catalog.agents.find((agent) => agent.key === 'claude')?.mcp.fileId, 'claude-mcp');
  assert.ok((catalog.agents.find((agent) => agent.key === 'claude')?.sections.length ?? 0) > 0);

  const report = await call<SettingsReport>('/api/settings');
  assert.deepEqual(report.agents.map((agent) => agent.key), ['claude', 'codex', 'pi']);

  const claude = await settingsFile('claude-settings');
  assert.equal(claude.exists, true);
  assert.match(claude.etag, /^[a-f0-9]{64}$/);
  assert.equal((claude.data as Record<string, any>).model, 'sonnet');
  assert.equal((claude.data as Record<string, any>).env.ANTHROPIC_AUTH_TOKEN, 'secret-visible');

  const claudeMcp = await settingsFile('claude-mcp');
  assert.equal(claudeMcp.exists, false);
  assert.equal(claudeMcp.etag, 'missing');
  assert.equal(claudeMcp.hostPath, join(home, '.claude.json'));

  const piMcp = await settingsFile('pi-mcp');
  assert.deepEqual(piMcp.data, { mcpServers: { shared: { command: 'pi-server' } } });
});

test('a settings save creates a missing file, bumps the etag and can be restored', async () => {
  const path = join(home, '.pi', 'agent', 'settings.json');
  const before = await settingsFile('pi-settings');
  assert.equal(before.exists, false);
  assert.equal(before.etag, 'missing');

  const saved = await call<SettingsSaveResult>('/api/settings/save', {
    fileId: 'pi-settings',
    etag: 'missing',
    data: { defaultModel: 'pi-test', custom: { keep: 1 } },
  });
  assert.equal(saved.file.exists, true);
  assert.match(saved.file.etag, /^[a-f0-9]{64}$/);
  assert.notEqual(saved.file.etag, 'missing');
  assert.deepEqual(saved.file.data, { defaultModel: 'pi-test', custom: { keep: 1 } });
  assert.equal(existsSync(path), true);

  const after = await settingsFile('pi-settings');
  assert.equal(after.etag, saved.file.etag);
  assert.deepEqual(after.data, { defaultModel: 'pi-test', custom: { keep: 1 } });

  const snapshots = await call<SnapshotManifest[]>('/api/snapshots');
  assert.ok(snapshots.some((snapshot) => snapshot.id === saved.snapshotId));

  await call('/api/snapshots/restore', { id: saved.snapshotId });
  assert.equal(existsSync(path), false);
});

test('Claude MCP saves merge only mcpServers and reject a stale etag', async () => {
  const path = join(home, '.claude.json');
  writeFileSync(
    path,
    `${JSON.stringify({ projects: { demo: { trusted: true } }, mcpServers: { old: { command: 'old' } } }, null, 2)}\n`,
  );

  const state = await settingsFile('claude-mcp');
  assert.deepEqual(state.data, { old: { command: 'old' } });

  const saved = await call<SettingsSaveResult>('/api/settings/save', {
    fileId: 'claude-mcp',
    etag: state.etag,
    data: { fresh: { command: 'fresh' } },
  });
  const host = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(host.projects, { demo: { trusted: true } });
  assert.deepEqual(host.mcpServers, { fresh: { command: 'fresh' } });

  writeFileSync(
    path,
    `${JSON.stringify({ projects: { demo: { trusted: true } }, mcpServers: { external: { command: 'e' } } }, null, 2)}\n`,
  );
  assert.equal(
    await postStatus('/api/settings/save', {
      fileId: 'claude-mcp',
      etag: saved.file.etag,
      data: { mine: { command: 'm' } },
    }),
    409,
  );
  const untouched = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(untouched.mcpServers, { external: { command: 'e' } });
  assert.deepEqual(untouched.projects, { demo: { trusted: true } });

  const current = await settingsFile('claude-mcp');
  await call('/api/settings/save', { fileId: 'claude-mcp', etag: current.etag, data: {} });
  const emptied = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  assert.equal('mcpServers' in emptied, false);
  assert.deepEqual(emptied.projects, { demo: { trusted: true } });
});

test('settings validation answers 400 for known fields but keeps unknown keys', async () => {
  const path = join(home, '.claude', 'settings.json');
  writeFileSync(path, '{"model":"sonnet"}\n');
  const etag = (await settingsFile('claude-settings')).etag;

  const invalid = [
    { model: 1 },
    { fastMode: 'yes' },
    { cleanupPeriodDays: 0 },
    { effortLevel: 'max' },
    { availableModels: [1] },
    { env: { A: 1 } },
  ];
  for (const data of invalid) {
    assert.equal(await postStatus('/api/settings/save', { fileId: 'claude-settings', etag, data }), 400);
  }
  assert.equal(readFileSync(path, 'utf8'), '{"model":"sonnet"}\n');

  const saved = await call<SettingsSaveResult>('/api/settings/save', {
    fileId: 'claude-settings',
    etag,
    data: { model: 'sonnet', unknown: { keep: true } },
  });
  assert.deepEqual((saved.file.data as Record<string, unknown>).unknown, { keep: true });

  const mcpState = await settingsFile('claude-mcp');
  const invalidMcp = [
    { plain: {} },
    { s: { type: 'stdio' } },
    { s: { type: 'http' } },
    { s: { command: 'x', args: [1] } },
    { s: { command: 'x', env: { A: 1 } } },
  ];
  for (const data of invalidMcp) {
    assert.equal(await postStatus('/api/settings/save', { fileId: 'claude-mcp', etag: mcpState.etag, data }), 400);
  }
});

test('raw settings text is parsed and validated without touching invalid files', async () => {
  const claudePath = join(home, '.claude', 'settings.json');
  writeFileSync(claudePath, '{"model":"base"}\n');
  let etag = (await settingsFile('claude-settings')).etag;

  assert.equal(
    await postStatus('/api/settings/save', { fileId: 'claude-settings', etag, text: '{ nope' }),
    400,
  );
  assert.equal(readFileSync(claudePath, 'utf8'), '{"model":"base"}\n');

  const saved = await call<SettingsSaveResult>('/api/settings/save', {
    fileId: 'claude-settings',
    etag,
    text: '{"model":"raw","custom":true}',
  });
  assert.equal(readFileSync(claudePath, 'utf8'), '{"model":"raw","custom":true}\n');
  assert.deepEqual(saved.file.data, { model: 'raw', custom: true });

  const codexPath = join(home, '.codex', 'config.toml');
  writeFileSync(codexPath, 'model = "old"\n');
  etag = (await settingsFile('codex-config')).etag;
  assert.equal(await postStatus('/api/settings/save', { fileId: 'codex-config', etag, text: 'model = ' }), 400);
  assert.equal(readFileSync(codexPath, 'utf8'), 'model = "old"\n');

  await call('/api/settings/save', {
    fileId: 'codex-config',
    etag,
    text: 'model = "new"\n[custom]\nnote = "keep"\n',
  });
  assert.equal(readFileSync(codexPath, 'utf8'), 'model = "new"\n[custom]\nnote = "keep"\n');
});

test('settings reject unknown ids and bodies above 1MB', async () => {
  assert.equal(
    await postStatus('/api/settings/save', { fileId: 'nope', etag: 'missing', data: { model: 'x' } }),
    404,
  );
  assert.equal(
    await postStatus('/api/settings/save', { fileId: '../escape', etag: 'missing', data: { model: 'x' } }),
    404,
  );
  const etag = (await settingsFile('claude-settings')).etag;
  assert.equal(
    await postStatus('/api/settings/save', { fileId: 'claude-settings', etag, text: 'x'.repeat(1_000_100) }),
    400,
  );
});

test('concurrent settings saves are serialized by the write queue', async () => {
  const path = join(home, '.pi', 'agent', 'settings.json');
  writeFileSync(path, '{"defaultModel":"start"}\n');
  const etag = (await settingsFile('pi-settings')).etag;

  const statuses = await Promise.all([
    postStatus('/api/settings/save', { fileId: 'pi-settings', etag, data: { defaultModel: 'first' } }),
    postStatus('/api/settings/save', { fileId: 'pi-settings', etag, data: { defaultModel: 'second' } }),
  ]);
  statuses.sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409]);

  const winner = await settingsFile('pi-settings');
  assert.ok(['first', 'second'].includes(String((winner.data as Record<string, unknown>).defaultModel)));

  const snapshots = await call<SnapshotManifest[]>('/api/snapshots');
  assert.ok(snapshots.some((snapshot) => snapshot.operation === 'settings pi-settings'));
});

test('settings files are in the open allowlist', () => {
  const config = createAppConfig({ projectRoot: home, home });
  for (const file of config.settingsFiles) {
    assert.ok(config.openable.has(file.path.toLowerCase()));
    if (file.hostPath) assert.ok(config.openable.has(file.hostPath.toLowerCase()));
  }
});
