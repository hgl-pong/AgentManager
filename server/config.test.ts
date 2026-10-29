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

test('URL credentials and credential arguments never reach the MCP summary', () => {
  const leaky = join(root, 'claude', 'leaky.json');
  writeFileSync(
    leaky,
    JSON.stringify({
      mcpServers: {
        remote: { url: 'https://user:sup3rsecret@example.com/sse' },
        flagged: { command: 'node', args: ['server.js', '--api-key', 'abc123', '--token=xyz789', '--verbose'] },
        minted: { command: 'cli', args: ['--auth', 'BearerValue', 'sk-live-abcdef1234567890'] },
        harmless: { command: 'typescript-language-server', args: ['--stdio'] },
      },
    }),
  );

  const report = scanConfig([{ agent: 'claude', label: 'Claude Code', path: leaky, format: 'json', role: 'x' }]);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes('sup3rsecret'));
  assert.ok(!serialized.includes('abc123'));
  assert.ok(!serialized.includes('xyz789'));
  assert.ok(!serialized.includes('BearerValue'));
  assert.ok(!serialized.includes('sk-live-abcdef1234567890'));

  const summary = (name: string) => report.servers.find((row) => row.name === name)?.byAgent.claude?.[0]?.summary;
  assert.equal(summary('remote'), 'https://example.com/sse');
  assert.equal(summary('flagged'), 'node server.js --api-key •••••• --token=•••••• --verbose');
  assert.equal(summary('minted'), 'cli --auth •••••• ••••••');
  assert.equal(summary('harmless'), 'typescript-language-server --stdio');
});

test('a read failure is an error, while only ENOENT reads as not existing', () => {
  const asDirectory = join(root, 'as-directory');
  mkdirSync(asDirectory, { recursive: true });

  const failed = scanConfig([{ agent: 'pi', label: 'pi', path: asDirectory, format: 'json', role: 'x' }]).files[0];
  assert.equal(failed?.exists, true);
  assert.ok(failed?.error);

  const absent = scanConfig([
    { agent: 'pi', label: 'pi', path: join(root, 'really-absent.json'), format: 'json', role: 'x' },
  ]).files[0];
  assert.equal(absent?.exists, false);
  assert.equal(absent?.error, undefined);
});
