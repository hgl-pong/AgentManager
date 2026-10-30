import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { alignPrompt, initPrompts, readPromptSource, savePromptSource, scanPrompts } from './prompts.ts';
import { restoreSnapshot } from './snapshot.ts';
import { AppError } from '../shared/types.ts';
import type { PromptTargetSpec } from './prompts.ts';

let root: string;
let source: string;
let snapshotRoot: string;
let targets: PromptTargetSpec[];

function writePrompt(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-manager-prompt-'));
  source = join(root, '.agents', 'prompts', 'global.md');
  snapshotRoot = join(root, 'snapshots');
  targets = [
    { key: 'claude', label: 'Claude Code', path: join(root, '.claude', 'CLAUDE.md') },
    { key: 'codex', label: 'Codex', path: join(root, '.codex', 'AGENTS.md') },
  ];
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const allowedRoots = () => [source, ...targets.map((target) => target.path)];

test('without a source every target reports no-source', () => {
  const report = scanPrompts(source, targets);
  assert.equal(report.source.exists, false);
  assert.deepEqual(report.targets.map((target) => target.state), ['no-source', 'no-source']);
});

test('init migrates the primary file into the source and links every target', () => {
  const claudePath = targets[0]?.path as string;
  writePrompt(claudePath, 'prompt v1');
  writePrompt(targets[1]?.path as string, 'older prompt');

  const result = initPrompts({ source, snapshotRoot, targets, primaryKey: 'claude' });

  assert.equal(readFileSync(source, 'utf8'), 'prompt v1');
  assert.deepEqual(result.report.targets.map((target) => target.state), ['synced', 'synced']);
  assert.deepEqual(result.report.targets.map((target) => target.link), ['hardlink', 'hardlink']);

  // A hard link means editing either side edits the one shared file.
  writeFileSync(claudePath, 'prompt v2');
  assert.equal(readFileSync(source, 'utf8'), 'prompt v2');

  restoreSnapshot(snapshotRoot, result.snapshotId, allowedRoots());
  assert.equal(existsSync(source), false);
  assert.equal(readFileSync(claudePath, 'utf8'), 'prompt v1');
  assert.equal(readFileSync(targets[1]?.path as string, 'utf8'), 'older prompt');
});

test('a plain copy with different content reports drift', () => {
  mkdirSync(join(source, '..'), { recursive: true });
  writeFileSync(source, 'canonical');
  writePrompt(targets[0]?.path as string, 'canonical');
  writePrompt(targets[1]?.path as string, 'changed by hand');

  const report = scanPrompts(source, targets);
  assert.deepEqual(report.targets.map((target) => target.state), ['synced', 'drift']);
  assert.deepEqual(report.targets.map((target) => target.link), ['copy', 'copy']);
});

test('align replaces a drifting copy with a link and can be rolled back', () => {
  const codexPath = targets[1]?.path as string;
  const result = alignPrompt({ source, snapshotRoot, targets }, 'codex');

  assert.equal(result.report.targets[1]?.state, 'synced');
  assert.equal(readFileSync(source, 'utf8'), 'canonical');

  restoreSnapshot(snapshotRoot, result.snapshotId, allowedRoots());
  assert.equal(readFileSync(codexPath, 'utf8'), 'changed by hand');
});

test('a link to another file is reported as external-link, a dangling one as broken', (t) => {
  const external = join(root, 'elsewhere.md');
  const first = targets[0]?.path as string;
  writeFileSync(external, 'other');
  rmSync(first, { force: true });
  try {
    symlinkSync(external, first, 'file');
  } catch {
    // Creating file symlinks needs developer mode or elevation on Windows.
    t.skip('file symlinks need developer mode on this machine');
    return;
  }

  let report = scanPrompts(source, targets);
  assert.equal(report.targets[0]?.state, 'external-link');

  rmSync(first, { force: true });
  const gone = join(root, 'gone.md');
  writeFileSync(gone, 'x');
  try {
    symlinkSync(gone, first, 'file');
  } catch {
    t.skip('file symlinks need developer mode on this machine');
    return;
  }
  rmSync(gone, { force: true });

  report = scanPrompts(source, targets);
  assert.equal(report.targets[0]?.state, 'broken');
  rmSync(first, { force: true });
});

test('align refuses an unknown agent with 400', () => {
  assert.throws(
    () => alignPrompt({ source, snapshotRoot, targets }, 'nope'),
    (error: unknown) => error instanceof AppError && error.status === 400,
  );
});

test('init without a source or a primary file is a 400', () => {
  const empty = mkdtempSync(join(tmpdir(), 'agent-manager-prompt-empty-'));
  try {
    const emptyTargets = [{ key: 'claude', label: 'Claude Code', path: join(empty, '.claude', 'CLAUDE.md') }];
    assert.throws(
      () =>
        initPrompts({
          source: join(empty, '.agents', 'prompts', 'global.md'),
          snapshotRoot: join(empty, 'snapshots'),
          targets: emptyTargets,
          primaryKey: 'claude',
        }),
      (error: unknown) => error instanceof AppError && error.status === 400,
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('init registers targets it creates so a restore removes them', () => {
  const extra = mkdtempSync(join(tmpdir(), 'agent-manager-prompt-extra-'));
  try {
    const extraSource = join(extra, '.agents', 'prompts', 'global.md');
    const extraSnapshotRoot = join(extra, 'snapshots');
    const extraTargets: PromptTargetSpec[] = [
      { key: 'claude', label: 'Claude Code', path: join(extra, '.claude', 'CLAUDE.md') },
      { key: 'codex', label: 'Codex', path: join(extra, '.codex', 'AGENTS.md') },
    ];
    writePrompt(extraTargets[0]?.path as string, 'seed prompt');

    const result = initPrompts({
      source: extraSource,
      snapshotRoot: extraSnapshotRoot,
      targets: extraTargets,
      primaryKey: 'claude',
    });

    assert.equal(existsSync(extraTargets[1]?.path as string), true);
    restoreSnapshot(extraSnapshotRoot, result.snapshotId, [extraSource, ...extraTargets.map((target) => target.path)]);

    assert.equal(existsSync(extraTargets[1]?.path as string), false);
    assert.equal(existsSync(extraSource), false);
    assert.equal(readFileSync(extraTargets[0]?.path as string, 'utf8'), 'seed prompt');
  } finally {
    rmSync(extra, { recursive: true, force: true });
  }
});

test('align registers a target it creates so a restore removes it', () => {
  const extra = mkdtempSync(join(tmpdir(), 'agent-manager-prompt-align-'));
  try {
    const extraSource = join(extra, '.agents', 'prompts', 'global.md');
    const extraSnapshotRoot = join(extra, 'snapshots');
    const extraTargets: PromptTargetSpec[] = [
      { key: 'claude', label: 'Claude Code', path: join(extra, '.claude', 'CLAUDE.md') },
    ];
    writePrompt(extraSource, 'canonical');
    assert.equal(existsSync(extraTargets[0]?.path as string), false);

    const result = alignPrompt(
      { source: extraSource, snapshotRoot: extraSnapshotRoot, targets: extraTargets, primaryKey: 'claude' },
      'claude',
    );
    assert.equal(existsSync(extraTargets[0]?.path as string), true);

    restoreSnapshot(extraSnapshotRoot, result.snapshotId, [extraSource, ...extraTargets.map((target) => target.path)]);
    assert.equal(existsSync(extraTargets[0]?.path as string), false);
  } finally {
    rmSync(extra, { recursive: true, force: true });
  }
});

test('the prompt source carries an etag that changes with its text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-manager-prompt-etag-'));
  try {
    const file = join(dir, 'global.md');
    const missing = readPromptSource(file);
    assert.equal(missing.exists, false);
    assert.equal(missing.content, '');
    assert.equal(missing.etag, 'missing');

    writePrompt(file, 'v1');
    const first = readPromptSource(file);
    assert.equal(first.exists, true);
    assert.notEqual(first.etag, missing.etag);
    assert.equal(readPromptSource(file).etag, first.etag, 'unchanged text keeps its etag');

    writePrompt(file, 'v2');
    assert.notEqual(readPromptSource(file).etag, first.etag, 'changed text changes the etag');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saving with a stale etag is refused and leaves the external edit in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-manager-prompt-conflict-'));
  try {
    const file = join(dir, '.agents', 'prompts', 'global.md');
    writePrompt(file, 'original');
    const input = { source: file, snapshotRoot: join(dir, 'snapshots'), targets: [] };
    const stale = readPromptSource(file).etag;

    // Someone else rewrites the canonical text after the editor read it.
    writePrompt(file, 'edited elsewhere');

    assert.throws(
      () => savePromptSource(input, 'my draft', stale),
      (error: unknown) => error instanceof AppError && error.status === 409,
    );
    assert.equal(readFileSync(file, 'utf8'), 'edited elsewhere', 'the external edit survives');

    // Reloading and saving with the fresh etag succeeds.
    const result = savePromptSource(input, 'my draft', readPromptSource(file).etag);
    assert.equal(readFileSync(file, 'utf8'), 'my draft');
    assert.equal(result.content.etag, readPromptSource(file).etag);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saving without an etag still writes (backwards compatible)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-manager-prompt-noetag-'));
  try {
    const file = join(dir, '.agents', 'prompts', 'global.md');
    writePrompt(file, 'original');
    const input = { source: file, snapshotRoot: join(dir, 'snapshots'), targets: [] };
    writePrompt(file, 'edited elsewhere');

    savePromptSource(input, 'my draft');
    assert.equal(readFileSync(file, 'utf8'), 'my draft');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
