import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { parse as parseToml } from 'smol-toml';

import { AppError } from '../shared/types.ts';
import { createAppConfig, startAgentServer } from './app.ts';
import { buildMcpReport, runMcpAction } from './mcp.ts';
import type { McpInput } from './mcp.ts';
import { restoreSnapshot } from './snapshot.ts';

import type { McpActionRequest, McpActionResponse, McpMatrixReport, McpMatrixRow } from '../shared/types.ts';

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Env {
  home: string;
  input: McpInput;
  restoreRoots: string[];
  claudePath: string;
  codexPath: string;
  piPath: string;
}

function fresh(): Env {
  const root = mkdtempSync(join(tmpdir(), 'agent-manager-mcp-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const config = createAppConfig({ projectRoot: root, home, dataDir: join(root, 'data') });
  const input: McpInput = {
    sourcePath: config.mcpSource,
    snapshotRoot: join(root, 'snapshots'),
    settingsFiles: config.settingsFiles,
  };
  return {
    home,
    input,
    restoreRoots: [config.mcpSource, ...config.settingsFiles.map((file) => file.hostPath ?? file.path)],
    claudePath: join(home, '.claude.json'),
    codexPath: join(home, '.codex', 'config.toml'),
    piPath: join(home, '.pi', 'agent', 'mcp.json'),
  };
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function writeJson(path: string, value: unknown): void {
  write(path, JSON.stringify(value, null, 2));
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** smol-toml builds null-prototype objects; round-trip through JSON for deepEqual. */
function readToml(path: string): Record<string, any> {
  return JSON.parse(JSON.stringify(parseToml(readFileSync(path, 'utf8'))));
}

function row(report: McpMatrixReport, name: string): McpMatrixRow {
  const found = report.rows.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`report has no row ${name}`);
  return found;
}

function states(report: McpMatrixReport, name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(row(report, name).cells).map(([key, cell]) => [key, cell.state]));
}

function act(env: Env, request: McpActionRequest): McpActionResponse {
  return runMcpAction(env.input, request);
}

function expectStatus(status: number, action: () => unknown): AppError {
  try {
    action();
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    assert.equal(error.status, status, error.message);
    return error;
  }
  assert.fail(`expected AppError ${status}, but the call succeeded`);
}

const STDIO = { command: 'npx', args: ['-y', 'pkg', '--token', 'secret-value'], env: { KEY: 'v' } };

test('without a source, agent servers are orphans and absent ones produce no row', () => {
  const env = fresh();
  writeJson(env.claudePath, { projects: {}, mcpServers: { lone: { type: 'stdio', command: 'node' } } });

  const report = buildMcpReport(env.input);
  assert.equal(report.source.exists, false);
  assert.equal(report.source.serverCount, 0);
  assert.deepEqual(report.rows.map((candidate) => candidate.name), ['lone']);
  assert.equal(row(report, 'lone').inSource, false);
  assert.deepEqual(states(report, 'lone'), { claude: 'orphan' });
  assert.equal(row(report, 'lone').cells.claude?.summary, 'node');
});

test('import builds the source from claude; other agents show missing', () => {
  const env = fresh();
  writeJson(env.claudePath, { projects: { x: 1 }, mcpServers: { tools: { type: 'stdio', ...STDIO, extra: true } } });

  const result = act(env, { action: 'import', name: 'tools', agent: 'claude' });
  assert.equal(result.snapshotIds.length, 1);
  const source = readJson(env.input.sourcePath);
  assert.deepEqual(source, { version: 1, servers: { tools: { transport: 'stdio', ...STDIO } } });
  assert.ok(readFileSync(env.input.sourcePath, 'utf8').endsWith('}\n'));
  assert.deepEqual(states(result.report, 'tools'), { claude: 'synced', codex: 'missing', pi: 'missing' });
  assert.equal(row(result.report, 'tools').cells.claude?.summary, 'npx -y pkg --token ••••••');
  assert.deepEqual(row(result.report, 'tools').source, { transport: 'stdio', ...STDIO });
});

test('sync writes codex TOML without type and with http_headers, pi JSON with type', () => {
  const env = fresh();
  writeJson(env.input.sourcePath, {
    version: 1,
    servers: {
      remote: { transport: 'http', url: 'https://u:p@example.com/mcp', headers: { Authorization: 'Bearer x' } },
      local: { transport: 'stdio', command: 'node', args: ['s.js'] },
    },
  });
  write(env.codexPath, 'model = "gpt-5"\n');

  const result = act(env, { action: 'sync' });
  assert.equal(result.snapshotIds.length, 3);
  assert.deepEqual(result.warnings, []);

  const codex = readToml(env.codexPath);
  assert.equal(codex.model, 'gpt-5');
  assert.deepEqual(codex.mcp_servers.remote, { url: 'https://u:p@example.com/mcp', http_headers: { Authorization: 'Bearer x' } });
  assert.deepEqual(codex.mcp_servers.local, { command: 'node', args: ['s.js'] });

  const pi = readJson(env.piPath);
  assert.deepEqual(pi.mcpServers.remote, { type: 'http', url: 'https://u:p@example.com/mcp', headers: { Authorization: 'Bearer x' } });
  assert.deepEqual(pi.mcpServers.local, { type: 'stdio', command: 'node', args: ['s.js'] });
  assert.equal(readJson(env.claudePath).mcpServers.remote.type, 'http');

  for (const name of ['remote', 'local']) {
    assert.deepEqual(states(result.report, name), { claude: 'synced', codex: 'synced', pi: 'synced' });
  }
  assert.equal(row(result.report, 'remote').cells.codex?.summary, 'https://example.com/mcp');

  const again = act(env, { action: 'sync' });
  assert.deepEqual(again.snapshotIds, [], 'an up-to-date agent is not rewritten');
});

test('hand edits show drift; sync restores synced and keeps unknown fields', () => {
  const env = fresh();
  writeJson(env.input.sourcePath, { version: 1, servers: { tools: { transport: 'stdio', command: 'node', args: ['a.js'] } } });
  write(env.codexPath, '[mcp_servers.tools]\ncommand = "node"\nargs = ["old.js"]\nenabled = false\nbearer_token_env_var = "TOK"\n');
  writeJson(env.piPath, { mcpServers: { tools: { command: 'node', args: ['a.js'], toolExposure: 'all', env: {} } } });

  const before = buildMcpReport(env.input);
  assert.deepEqual(states(before, 'tools'), { claude: 'missing', codex: 'drift', pi: 'synced' });

  const result = act(env, { action: 'sync', name: 'tools', agents: ['codex'] });
  assert.equal(result.snapshotIds.length, 1);
  const codex = readToml(env.codexPath);
  assert.deepEqual(codex.mcp_servers.tools, { command: 'node', args: ['a.js'], enabled: false, bearer_token_env_var: 'TOK' });
  assert.deepEqual(states(result.report, 'tools'), { claude: 'missing', codex: 'synced', pi: 'synced' });

  // Switching transport drops the stdio core fields but keeps the agent-only ones.
  act(env, { action: 'saveSource', name: 'tools', server: { transport: 'http', url: 'https://h/mcp' }, agents: ['codex', 'pi'] });
  assert.deepEqual(readToml(env.codexPath).mcp_servers.tools, {
    enabled: false,
    bearer_token_env_var: 'TOK',
    url: 'https://h/mcp',
  });
  assert.deepEqual(readJson(env.piPath).mcpServers.tools, { toolExposure: 'all', type: 'http', url: 'https://h/mcp' });
});

test('importAll fills gaps by preference, warns on conflicts and keeps existing source entries', () => {
  const env = fresh();
  writeJson(env.input.sourcePath, { version: 1, servers: { kept: { transport: 'stdio', command: 'keep' } } });
  writeJson(env.claudePath, {
    mcpServers: { shared: { command: 'claude-cmd' }, kept: { command: 'other' }, same: { url: 'https://s' } },
  });
  write(env.codexPath, '[mcp_servers.shared]\ncommand = "codex-cmd"\n\n[mcp_servers.only]\nurl = "https://o"\n\n[mcp_servers.same]\nurl = "https://s"\n');
  writeJson(env.piPath, { mcpServers: { shared: { command: 'pi-cmd' }, broken: 'nope' } });

  const result = act(env, { action: 'importAll', prefer: 'codex' });
  assert.equal(result.snapshotIds.length, 1);
  const servers = readJson(env.input.sourcePath).servers;
  assert.deepEqual(servers.kept, { transport: 'stdio', command: 'keep' });
  assert.deepEqual(servers.shared, { transport: 'stdio', command: 'codex-cmd' });
  assert.deepEqual(servers.only, { transport: 'http', url: 'https://o' });
  assert.deepEqual(servers.same, { transport: 'http', url: 'https://s' });
  assert.equal(servers.broken, undefined);
  assert.ok(result.warnings.includes('shared：以 Codex 为准'), result.warnings.join('\n'));
  assert.ok(!result.warnings.some((warning) => warning.startsWith('same')));
  assert.ok(result.warnings.some((warning) => warning.startsWith('broken')));

  const defaults = fresh();
  writeJson(defaults.claudePath, { mcpServers: { shared: { command: 'claude-cmd' } } });
  writeJson(defaults.piPath, { mcpServers: { shared: { command: 'pi-cmd' } } });
  const preferred = act(defaults, { action: 'importAll' });
  assert.equal(readJson(defaults.input.sourcePath).servers.shared.command, 'claude-cmd');
  assert.deepEqual(preferred.warnings, ['shared：以 Claude Code 为准']);
});

test('deleteSource leaves agent entries behind as orphans', () => {
  const env = fresh();
  writeJson(env.claudePath, { mcpServers: { tools: { command: 'node' } } });
  act(env, { action: 'import', name: 'tools', agent: 'claude' });

  const result = act(env, { action: 'deleteSource', name: 'tools' });
  assert.equal(result.snapshotIds.length, 1);
  assert.deepEqual(readJson(env.input.sourcePath).servers, {});
  assert.deepEqual(states(result.report, 'tools'), { claude: 'orphan' });
  assert.deepEqual(readJson(env.claudePath).mcpServers, { tools: { command: 'node' } });
});

test('remove deletes the entry from the chosen agent only', () => {
  const env = fresh();
  writeJson(env.claudePath, { other: 1, mcpServers: { tools: { command: 'node' } } });
  writeJson(env.piPath, { mcpServers: { tools: { command: 'node' } } });

  const result = act(env, { action: 'remove', name: 'tools', agent: 'claude' });
  assert.equal(result.snapshotIds.length, 1);
  assert.deepEqual(readJson(env.claudePath), { other: 1 });
  assert.deepEqual(states(result.report, 'tools'), { pi: 'orphan' });
  expectStatus(404, () => act(env, { action: 'remove', name: 'tools', agent: 'claude' }));
});

test('an sse source is synced on claude, unsupported on codex/pi, and never written there', () => {
  const env = fresh();
  writeJson(env.input.sourcePath, { version: 1, servers: { events: { transport: 'sse', url: 'https://e/sse' } } });

  const result = act(env, { action: 'sync', name: 'events' });
  assert.equal(result.snapshotIds.length, 1);
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.every((warning) => warning.includes('sse')));
  assert.deepEqual(readJson(env.claudePath).mcpServers.events, { type: 'sse', url: 'https://e/sse' });
  assert.equal(existsSync(env.codexPath), false);
  assert.equal(existsSync(env.piPath), false);
  assert.deepEqual(states(result.report, 'events'), { claude: 'synced', codex: 'unsupported', pi: 'unsupported' });
});

test('agent entries that are not objects or cannot be normalized are invalid', () => {
  const env = fresh();
  writeJson(env.input.sourcePath, { version: 1, servers: { tools: { transport: 'stdio', command: 'node' } } });
  writeJson(env.claudePath, { mcpServers: { tools: 'node' } });
  writeJson(env.piPath, { mcpServers: { tools: { type: 'websocket', url: 'ws://x' } } });
  write(env.codexPath, '[mcp_servers.tools]\nargs = ["x"]\n');

  const report = buildMcpReport(env.input);
  assert.deepEqual(states(report, 'tools'), { claude: 'invalid', codex: 'invalid', pi: 'invalid' });
  assert.ok(row(report, 'tools').cells.claude?.error);
  assert.match(row(report, 'tools').cells.pi?.error ?? '', /websocket/);
});

test('saveSource rejects bad names, transports and missing command/url with 400', () => {
  const env = fresh();
  const save = (name: unknown, server: unknown) =>
    act(env, { action: 'saveSource', name: name as string, server: server as never });
  expectStatus(400, () => save('', { transport: 'stdio', command: 'x' }));
  expectStatus(400, () => save('a/b', { transport: 'stdio', command: 'x' }));
  expectStatus(400, () => save('a\\b', { transport: 'stdio', command: 'x' }));
  // Plain-object keys: a `__proto__` entry would set the prototype instead of writing a server.
  expectStatus(400, () => save('__proto__', { transport: 'stdio', command: 'x' }));
  expectStatus(400, () => save('constructor', { transport: 'stdio', command: 'x' }));
  expectStatus(400, () => save('x'.repeat(101), { transport: 'stdio', command: 'x' }));
  expectStatus(400, () => save('ok', { transport: 'ws', url: 'x' }));
  expectStatus(400, () => save('ok', { transport: 'stdio' }));
  expectStatus(400, () => save('ok', { transport: 'http', command: 'x' }));
  expectStatus(400, () => save('ok', { transport: 'sse', url: '' }));
  expectStatus(400, () => save('ok', { transport: 'stdio', command: 'x', args: [1] }));
  expectStatus(400, () => save('ok', { transport: 'stdio', command: 'x', env: { A: 1 } }));
  expectStatus(400, () => save('ok', { transport: 'http', url: 'x', headers: 'h' }));
  expectStatus(400, () => save('ok', { transport: 'stdio', command: 'x', cwd: 3 }));
  expectStatus(400, () => act(env, { action: 'nope' as never }));
  expectStatus(400, () => act(env, { action: 'sync', agents: ['nope'] }));
  assert.equal(existsSync(env.input.sourcePath), false);

  const ok = save('ok', { transport: 'stdio', command: 'x', args: [], env: {}, url: 'ignored' });
  assert.deepEqual(readJson(env.input.sourcePath).servers.ok, { transport: 'stdio', command: 'x' });
  assert.equal(ok.snapshotIds.length, 1);
});

test('import and sync snapshots restore the previous files', () => {
  const env = fresh();
  writeJson(env.claudePath, { mcpServers: { tools: { command: 'node' } } });
  write(env.codexPath, 'model = "m"\n');
  const codexBefore = readFileSync(env.codexPath, 'utf8');

  const imported = act(env, { action: 'import', name: 'tools', agent: 'claude' });
  const synced = act(env, { action: 'sync', name: 'tools', agents: ['codex', 'pi'] });
  assert.equal(synced.snapshotIds.length, 2);
  assert.ok(existsSync(env.piPath));

  for (const id of [...synced.snapshotIds].reverse()) restoreSnapshot(env.input.snapshotRoot, id, env.restoreRoots);
  assert.equal(readFileSync(env.codexPath, 'utf8'), codexBefore);
  assert.equal(existsSync(env.piPath), false);

  restoreSnapshot(env.input.snapshotRoot, imported.snapshotIds[0] as string, env.restoreRoots);
  assert.equal(existsSync(env.input.sourcePath), false);
});

test('a corrupt source reports source.error and every write answers 400', () => {
  const env = fresh();
  write(env.input.sourcePath, '{ not json');
  writeJson(env.claudePath, { mcpServers: { tools: { command: 'node' } } });

  const report = buildMcpReport(env.input);
  assert.ok(report.source.error);
  assert.equal(report.source.exists, true);
  assert.deepEqual(states(report, 'tools'), { claude: 'orphan' });
  for (const request of [
    { action: 'import', name: 'tools', agent: 'claude' },
    { action: 'importAll' },
    { action: 'saveSource', name: 'x', server: { transport: 'stdio', command: 'x' } },
    { action: 'deleteSource', name: 'tools' },
    { action: 'sync' },
    { action: 'remove', name: 'tools', agent: 'claude' },
  ] as McpActionRequest[]) {
    expectStatus(400, () => act(env, request));
  }
  assert.equal(readFileSync(env.input.sourcePath, 'utf8'), '{ not json');

  write(env.input.sourcePath, '[]');
  assert.match(buildMcpReport(env.input).source.error ?? '', /对象/);
});

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

test('GET/POST /api/mcp return the report shape and go through the write guard', async () => {
  const env = fresh();
  writeJson(env.input.sourcePath, { version: 1, servers: { a: { transport: 'stdio', command: 'x' }, b: { transport: 'http', url: 'https://b' } } });
  writeJson(env.claudePath, { mcpServers: { z: { command: 'z' } } });

  const config = createAppConfig({ projectRoot: dirname(env.home), home: env.home, dataDir: join(dirname(env.home), 'data') });
  assert.ok(config.openable.has(config.mcpSource.toLowerCase()));
  const port = await freePort();
  const app = await startAgentServer(config, { port, startedAt: new Date().toISOString() });
  try {
    const base = `http://127.0.0.1:${port}`;
    const report = (await (await fetch(`${base}/api/mcp`)).json()) as McpMatrixReport;
    assert.equal(report.source.path, config.mcpSource);
    assert.equal(report.source.serverCount, 2);
    assert.equal(typeof report.source.bytes, 'number');
    assert.deepEqual(report.agents, [
      { key: 'claude', label: 'Claude Code', file: env.claudePath, format: 'json' },
      { key: 'codex', label: 'Codex', file: env.codexPath, format: 'toml' },
      { key: 'pi', label: 'pi', file: env.piPath, format: 'json' },
    ]);
    assert.deepEqual(report.rows.map((candidate) => candidate.name), ['a', 'b', 'z']);
    assert.ok(!Number.isNaN(Date.parse(report.scannedAt)));

    const post = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
      fetch(`${base}/api/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await post({ action: 'sync' }, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post({ action: 'saveSource', name: 'bad/name', server: { transport: 'stdio', command: 'x' } })).status, 400);

    const response = await post({ action: 'sync', name: 'a' });
    assert.equal(response.status, 200);
    const result = (await response.json()) as McpActionResponse;
    assert.equal(result.snapshotIds.length, 3);
    assert.deepEqual(states(result.report, 'a'), { claude: 'synced', codex: 'synced', pi: 'synced' });
    assert.equal(typeof result.message, 'string');
    assert.deepEqual(result.warnings, []);
  } finally {
    await app.close();
  }
});
