import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { cacheTargets, runCacheAction, scanCache } from './cache.ts';
import type { CacheInput } from './cache.ts';
import { createAppConfig, startAgentServer } from './app.ts';
import { AppError } from '../shared/types.ts';
import type {
  CacheActionRequest,
  CacheActionResponse,
  CacheReport,
  CacheTargetReport,
} from '../shared/types.ts';

const DAY = 24 * 60 * 60 * 1000;
const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Env {
  home: string;
  input: CacheInput;
}

function fresh(): Env {
  const root = mkdtempSync(join(tmpdir(), 'agent-manager-cache-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return { home, input: { targets: cacheTargets(home), recycleRoot: join(root, 'recycle') } };
}

/** Writes a file and backdates it, so age buckets and cutoffs can be asserted exactly. */
function write(path: string, text: string, ageDays = 0): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (ageDays > 0) {
    const at = new Date(Date.now() - ageDays * DAY);
    utimesSync(path, at, at);
  }
}

function target(env: Env, id: string): CacheTargetReport {
  const found = scanCache(env.input).targets.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`report has no target ${id}`);
  return found;
}

function act(env: Env, request: CacheActionRequest): CacheActionResponse {
  return runCacheAction(env.input, request);
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

function bucket(report: CacheTargetReport, days: number): { bytes: number; files: number } {
  const found = report.buckets.find((candidate) => candidate.days === days);
  if (!found) throw new Error(`report has no bucket ${days}`);
  return { bytes: found.bytes, files: found.files };
}

function recycleFiles(env: Env): string[] {
  const items = scanCache(env.input).recycle.items;
  return items.flatMap((item) => item.entries.map((entry) => entry.originalPath));
}

test('targets cover all three agents and never point at a live config file', () => {
  const env = fresh();
  const home = env.home;

  assert.deepEqual([...new Set(env.input.targets.map((spec) => spec.agent))], ['claude', 'codex', 'pi']);
  for (const spec of env.input.targets) {
    assert.ok(spec.path.startsWith(home), `${spec.id} escapes the home directory`);
    assert.ok(!/settings\.json$|config\.toml$|AGENTS\.md$/i.test(spec.path), `${spec.id} points at config`);
    assert.ok(spec.openPath.startsWith(home));
    if (spec.kind === 'glob') assert.equal(spec.openPath, dirname(spec.path));
  }
  assert.equal(new Set(env.input.targets.map((spec) => spec.id)).size, env.input.targets.length);
});

test('scan measures files, counts age buckets and never follows links', () => {
  const env = fresh();
  const projects = join(env.home, '.claude', 'projects', 'proj-a');
  write(join(projects, 'new.jsonl'), 'a'.repeat(100), 0);
  write(join(projects, 'old2.jsonl'), 'b'.repeat(200), 2);
  write(join(projects, 'old10.jsonl'), 'c'.repeat(300), 10);
  write(join(projects, 'old40.jsonl'), 'd'.repeat(400), 40);
  // A junction to content that must never be counted nor cleaned.
  const outside = join(env.home, 'outside-cache');
  write(join(outside, 'huge.bin'), 'x'.repeat(4096), 400);
  symlinkSync(outside, join(projects, 'linked'), 'junction');

  const report = target(env, 'claude.projects');

  assert.equal(report.exists, true);
  assert.equal(report.files, 4);
  assert.equal(report.bytes, 1000);
  assert.deepEqual(bucket(report, 1), { bytes: 900, files: 3 });
  assert.deepEqual(bucket(report, 7), { bytes: 700, files: 2 });
  assert.deepEqual(bucket(report, 30), { bytes: 400, files: 1 });
  assert.deepEqual(bucket(report, 90), { bytes: 0, files: 0 });
  assert.ok(report.oldest && report.newest);
  assert.ok(Date.parse(report.oldest) < Date.parse(report.newest));

  const absent = target(env, 'codex.sessions');
  assert.equal(absent.exists, false);
  assert.equal(absent.files, 0);
});

test('a clean moves only files older than the cutoff and keeps the rest', () => {
  const env = fresh();
  const projects = join(env.home, '.claude', 'projects', 'proj-a');
  const old = join(projects, 'old.jsonl');
  const young = join(projects, 'fresh.jsonl');
  write(old, 'old', 40);
  write(young, 'fresh', 0);

  const result = act(env, { action: 'clean', ids: ['claude.projects'], olderThanDays: 30 });

  assert.equal(result.movedFiles, 1);
  assert.equal(result.movedBytes, 3);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(young), true);
  assert.deepEqual(recycleFiles(env), [old]);
  assert.equal(result.report.targets.find((entry) => entry.id === 'claude.projects')?.files, 1);
  assert.match(result.message, /回收站/);
});

test('a clean writes its manifest and updates it as items move', () => {
  const env = fresh();
  const projects = join(env.home, '.claude', 'projects');
  const files = [join(projects, 'proj-a', 'a.jsonl'), join(projects, 'proj-b', 'b.jsonl')];
  for (const file of files) write(file, 'x', 40);

  act(env, { action: 'clean', ids: ['claude.projects'], olderThanDays: 30 });

  const [itemDir] = readdirSync(env.input.recycleRoot);
  const manifest = JSON.parse(readFileSync(join(env.input.recycleRoot, itemDir!, 'manifest.json'), 'utf8'));
  assert.deepEqual(
    manifest.entries.map((entry: { originalPath: string }) => entry.originalPath).sort(),
    [...files].sort(),
  );
});

test('a whole-target clean moves the directory as one restorable item', () => {
  const env = fresh();
  const sessions = join(env.home, '.codex', 'sessions', '2026', '10');
  write(join(sessions, 'rollout.jsonl'), 'rollout', 3);

  const result = act(env, { action: 'clean', ids: ['codex.sessions'], olderThanDays: 0 });

  assert.equal(existsSync(join(env.home, '.codex', 'sessions')), false);
  assert.equal(result.report.targets.find((entry) => entry.id === 'codex.sessions')?.exists, false);
  const item = result.report.recycle.items[0];
  assert.ok(item);
  assert.equal(item.files, 1);
  assert.equal(item.entries[0]?.kind, 'dir');

  const restored = act(env, { action: 'restore', recycleIds: [item.id] });

  assert.equal(existsSync(join(sessions, 'rollout.jsonl')), true);
  assert.equal(restored.report.recycle.items.length, 0);
  assert.match(restored.message, /已恢复 1 个文件/);
});

test('a partial clean prunes the directories it empties', () => {
  const env = fresh();
  const keepDir = join(env.home, '.claude', 'file-history', 'keep');
  const dropDir = join(env.home, '.claude', 'file-history', 'drop', 'nested');
  write(join(keepDir, 'recent.txt'), 'recent', 0);
  write(join(dropDir, 'ancient.txt'), 'ancient', 90);

  act(env, { action: 'clean', ids: ['claude.file-history'], olderThanDays: 30 });

  assert.equal(existsSync(keepDir), true);
  assert.equal(existsSync(join(env.home, '.claude', 'file-history', 'drop')), false);
});

test('a fresh sqlite sidecar protects its whole group from a partial clean', () => {
  const env = fresh();
  const codex = join(env.home, '.codex');
  const db = join(codex, 'logs_2.sqlite');
  const wal = join(codex, 'logs_2.sqlite-wal');
  write(db, 'db', 40);
  write(wal, 'wal', 0);

  const kept = act(env, { action: 'clean', ids: ['codex.logs'], olderThanDays: 30 });
  assert.equal(kept.movedFiles ?? 0, 0);
  assert.equal(existsSync(db), true);
  assert.equal(existsSync(wal), true);
  assert.match(kept.message, /没有符合条件/);

  write(wal, 'wal', 40);
  const cleaned = act(env, { action: 'clean', ids: ['codex.logs'], olderThanDays: 30 });
  assert.equal(cleaned.movedFiles, 2);
  assert.equal(existsSync(db), false);
  assert.equal(existsSync(wal), false);
});

test('a glob clean skips live configuration but takes bak files', () => {
  const env = fresh();
  const claude = join(env.home, '.claude');
  write(join(claude, 'settings.json'), '{"live":true}');
  write(join(claude, 'settings.json.bak-20260101-000000'), 'old settings', 40);
  write(join(claude, 'history.jsonl'), 'prompt', 40);

  const report = target(env, 'claude.backup-files');
  assert.equal(report.files, 1);

  act(env, { action: 'clean', ids: ['claude.backup-files'], olderThanDays: 30 });
  assert.equal(existsSync(join(claude, 'settings.json')), true);
  assert.equal(existsSync(join(claude, 'settings.json.bak-20260101-000000')), false);
  assert.equal(existsSync(join(claude, 'history.jsonl')), true);
});

test('a restore never overwrites content that reappeared at the original path', () => {
  const env = fresh();
  const file = join(env.home, '.pi', 'agent', 'sessions', 'a.jsonl');
  write(file, 'session', 10);

  const first = act(env, { action: 'clean', ids: ['pi.sessions'], olderThanDays: 7 });
  const itemId = first.recycleId;
  assert.ok(itemId);
  write(file, 'a new session by the agent', 0);

  const blocked = act(env, { action: 'restore', recycleIds: [itemId] });

  assert.deepEqual(blocked.skipped, [file]);
  assert.equal(blocked.report.recycle.items.length, 1, 'the entry stays in the bin when it cannot go home');
  assert.match(blocked.message, /没能恢复/);

  rmSync(file);
  const restored = act(env, { action: 'restore', recycleIds: [itemId] });
  assert.equal(restored.skipped, undefined);
  assert.equal(existsSync(file), true);
  assert.equal(restored.report.recycle.items.length, 0);
});

test('purge deletes one item or the whole bin and says what it removed', () => {
  const env = fresh();
  write(join(env.home, '.claude', 'cache', 'a.bin'), 'a', 10);
  write(join(env.home, '.claude', 'debug', 'b.log'), 'b', 10);

  const one = act(env, { action: 'clean', ids: ['claude.cache'], olderThanDays: 0 });
  const two = act(env, { action: 'clean', ids: ['claude.debug'], olderThanDays: 0 });
  assert.equal(two.report.recycle.items.length, 2);

  act(env, { action: 'purge', recycleIds: [String(one.recycleId)] });
  assert.equal(scanCache(env.input).recycle.items.length, 1);
  assert.equal(readdirSync(env.input.recycleRoot).length, 1);

  const emptied = act(env, { action: 'purge' });
  assert.equal(emptied.report.recycle.items.length, 0);
  assert.equal(emptied.report.recycle.bytes, 0);
  assert.match(emptied.message, /无法再恢复/);

  const again = act(env, { action: 'purge' });
  assert.match(again.message, /回收站是空的/);
  assert.equal(readdirSync(env.input.recycleRoot).length, 0);
});

test('actions reject unknown ids, bad ranges and illegal recycle ids', () => {
  const env = fresh();

  expectStatus(400, () => act(env, { action: 'clean', ids: [] }));
  expectStatus(400, () => act(env, { action: 'clean', ids: ['nope'] }));
  expectStatus(400, () => act(env, { action: 'clean', ids: ['claude.cache'], olderThanDays: -1 }));
  expectStatus(400, () => act(env, { action: 'clean', ids: ['claude.cache'], olderThanDays: 1.5 }));
  expectStatus(400, () => act(env, { action: 'restore', recycleIds: [] }));
  expectStatus(400, () => act(env, { action: 'purge', recycleIds: ['../../etc'] }));
  expectStatus(404, () => act(env, { action: 'purge', recycleIds: ['20260101-000000-deadbeef'] }));
  expectStatus(400, () => act(env, { action: 'clean' as never }));
});

test('a file target that names a config file reports the mistake instead of deleting', () => {
  const env = fresh();
  const spec = {
    id: 'test.settings',
    agent: 'claude',
    agentLabel: 'Claude Code',
    label: '设置文件',
    path: join(env.home, '.claude', 'settings.json'),
    kind: 'file' as const,
    risk: 'cache' as const,
    note: undefined,
    openPath: join(env.home, '.claude', 'settings.json'),
  };
  const input: CacheInput = { targets: [spec], recycleRoot: env.input.recycleRoot };
  write(spec.path, '{"live":true}');

  const report = scanCache(input);
  assert.match(report.targets[0]?.error ?? '', /配置文件/);
  expectStatus(500, () => runCacheAction(input, { action: 'clean', ids: ['test.settings'] }));
  assert.equal(existsSync(spec.path), true);
});

test('scanCache does not write: the recycle bin only appears after a clean', () => {
  const env = fresh();
  write(join(env.home, '.claude', 'cache', 'x.bin'), 'x', 1);

  scanCache(env.input);

  assert.equal(existsSync(env.input.recycleRoot), false);
  assert.equal(existsSync(join(env.home, '.claude', 'cache', 'x.bin')), true);
});

test('a manifest cannot redirect a purge at another item', () => {
  const env = fresh();
  write(join(env.home, '.claude', 'cache', 'a.bin'), 'a', 10);
  write(join(env.home, '.claude', 'debug', 'b.log'), 'b', 10);
  const one = String(act(env, { action: 'clean', ids: ['claude.cache'] }).recycleId);
  const two = String(act(env, { action: 'clean', ids: ['claude.debug'] }).recycleId);

  const manifestPath = join(env.input.recycleRoot, one, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { id: string };
  manifest.id = two;
  writeFileSync(manifestPath, JSON.stringify(manifest));

  act(env, { action: 'purge', recycleIds: [one] });

  assert.equal(existsSync(join(env.input.recycleRoot, one)), false);
  assert.equal(existsSync(join(env.input.recycleRoot, two)), true);
  assert.deepEqual(scanCache(env.input).recycle.items.map((item) => item.id), [two]);
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

test('GET/POST /api/cache expose the report and go through the write guard', async () => {
  const env = fresh();
  const old = join(env.home, '.claude', 'projects', 'p', 'old.jsonl');
  write(old, 'old session', 40);

  const config = createAppConfig({ projectRoot: dirname(env.home), home: env.home, dataDir: join(dirname(env.home), 'data') });
  assert.ok(config.openable.has(config.cacheRecycleRoot.toLowerCase()));
  for (const spec of config.cacheTargets) assert.ok(config.openable.has(spec.openPath.toLowerCase()));

  const port = await freePort();
  const app = await startAgentServer(config, { port, startedAt: new Date().toISOString() });
  try {
    const base = `http://127.0.0.1:${port}`;
    const report = (await (await fetch(`${base}/api/cache`)).json()) as CacheReport;
    assert.equal(report.recycle.path, config.cacheRecycleRoot);
    const projects = report.targets.find((entry) => entry.id === 'claude.projects');
    assert.equal(projects?.files, 1);
    assert.ok((projects?.buckets.length ?? 0) > 0);
    assert.ok(typeof report.durationMs === 'number');

    const post = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
      fetch(`${base}/api/cache`, { method: 'POST', headers, body: JSON.stringify(body) });

    assert.equal((await post({ action: 'clean', ids: ['claude.projects'] }, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post({ action: 'clean', ids: ['unknown'] })).status, 400);

    const cleaned = await post({ action: 'clean', ids: ['claude.projects'], olderThanDays: 30 });
    assert.equal(cleaned.status, 200);
    const result = (await cleaned.json()) as CacheActionResponse;
    assert.equal(result.movedFiles, 1);
    assert.equal(existsSync(old), false);
    assert.equal(result.report.recycle.items.length, 1);
  } finally {
    await app.close();
  }
});