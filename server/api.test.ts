import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ConfigReport, MatrixResponse, PromptsReport, SnapshotManifest } from '../shared/types.ts';

const PORT = 7799;
const BASE = `http://127.0.0.1:${PORT}`;

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
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ model: 'sonnet', mcpServers: { shared: { command: 'npx', args: ['-y', 'pkg'] } } }),
  );
  writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.shared]\ncommand = "node"\nargs = ["s.js"]\n');

  server = spawn(process.execPath, ['server/index.ts'], {
    env: { ...process.env, AGENT_MANAGER_HOME: home, PORT: String(PORT) },
    stdio: 'ignore',
  });

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

test('prompts start without a source and init migrates CLAUDE.md', async () => {
  const before = await call<PromptsReport>('/api/prompts');
  assert.equal(before.source.exists, false);
  assert.equal(before.targets[0]?.state, 'no-source');

  const result = await call<{ report: PromptsReport; snapshotId: string }>('/api/prompts', { action: 'init' });
  assert.equal(result.report.source.exists, true);
  assert.deepEqual(result.report.targets.map((target) => target.state), ['synced', 'synced']);
  assert.equal(readFileSync(join(home, '.agents', 'prompts', 'global.md'), 'utf8'), 'claude prompt');

  await call('/api/snapshots/restore', { id: result.snapshotId });
  assert.equal(existsSync(join(home, '.agents', 'prompts', 'global.md')), false);
  assert.equal(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8'), 'claude prompt');
});

test('config merges JSON and TOML MCP servers', async () => {
  const report = await call<ConfigReport>('/api/config');
  const shared = report.servers.find((row) => row.name === 'shared');
  assert.equal(shared?.byAgent.claude?.[0]?.summary, 'npx -y pkg');
  assert.equal(shared?.byAgent.codex?.[0]?.summary, 'node s.js');
});

test('opening a path outside the allowlist is refused', async () => {
  await assert.rejects(() => call('/api/open', { path: 'C:\\Windows\\System32\\calc.exe' }), /白名单/);
});
