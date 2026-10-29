import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { scanConfig } from './config.ts';
import type { ConfigFileSpec } from './config.ts';

let root: string;
let files: ConfigFileSpec[];

before(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-manager-config-'));
  mkdirSync(join(root, 'claude'), { recursive: true });
  mkdirSync(join(root, 'codex'), { recursive: true });

  const claudePath = join(root, 'claude', 'settings.json');
  writeFileSync(
    claudePath,
    JSON.stringify({
      api_key: 'sk-should-not-be-shown',
      model: 'sonnet',
      env: { ANTHROPIC_AUTH_TOKEN: 'secret-value', PLAIN: 'visible' },
      mcpServers: { shared: { command: 'npx', args: ['-y', 'pkg'] }, claudeOnly: { url: 'http://127.0.0.1:9/sse' } },
    }),
  );

  const codexPath = join(root, 'codex', 'config.toml');
  writeFileSync(
    codexPath,
    ['model = "gpt"', '', '[mcp_servers.shared]', 'command = "node"', 'args = ["server.js"]', ''].join('\n'),
  );

  files = [
    { agent: 'claude', label: 'Claude Code', path: claudePath, format: 'json', role: 'settings' },
    { agent: 'codex', label: 'Codex', path: codexPath, format: 'toml', role: 'config' },
    { agent: 'pi', label: 'pi', path: join(root, 'pi', 'settings.json'), format: 'json', role: 'settings' },
  ];
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test('missing config files are reported as absent without failing the scan', () => {
  const report = scanConfig(files);
  const pi = report.files.find((file) => file.agent === 'pi');
  assert.equal(pi?.exists, false);
  assert.deepEqual(pi?.keys, []);
});

test('JSON and TOML are both parsed into top-level keys', () => {
  const report = scanConfig(files);
  const claude = report.files.find((file) => file.agent === 'claude');
  const codex = report.files.find((file) => file.agent === 'codex');

  assert.deepEqual(claude?.keys.map((entry) => entry.key), ['api_key', 'model', 'env', 'mcpServers']);
  assert.deepEqual(codex?.keys.map((entry) => entry.key), ['model', 'mcp_servers']);
  assert.deepEqual(codex?.mcpKeys, ['shared']);
});

test('secret-looking values are redacted, plain ones are shown', () => {
  const report = scanConfig(files);
  const keys = report.files.find((file) => file.agent === 'claude')?.keys ?? [];
  const secret = keys.find((entry) => entry.key === 'api_key');
  const plain = keys.find((entry) => entry.key === 'model');

  assert.equal(secret?.preview, '••••••');
  assert.equal(plain?.preview, 'sonnet');
  assert.ok(!JSON.stringify(report).includes('sk-should-not-be-shown'));
});

test('MCP servers from both formats land in one matrix', () => {
  const report = scanConfig(files);
  const shared = report.servers.find((row) => row.name === 'shared');
  const claudeOnly = report.servers.find((row) => row.name === 'claudeOnly');

  assert.equal(shared?.byAgent.claude?.[0]?.summary, 'npx -y pkg');
  assert.equal(shared?.byAgent.codex?.[0]?.summary, 'node server.js');
  assert.equal(claudeOnly?.byAgent.codex, undefined);
  assert.equal(claudeOnly?.byAgent.claude?.[0]?.summary, 'http://127.0.0.1:9/sse');
});

test('a broken config file reports its parse error instead of throwing', () => {
  const bad = join(root, 'codex', 'broken.toml');
  writeFileSync(bad, 'this is not = = toml');
  const report = scanConfig([{ agent: 'codex', label: 'Codex', path: bad, format: 'toml', role: 'x' }]);
  assert.equal(report.files[0]?.exists, true);
  assert.ok(report.files[0]?.error);
});
