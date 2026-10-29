import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { alignPrompt, initPrompts, scanPrompts } from './prompts.ts';
import { restoreSnapshot } from './snapshot.ts';
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

  restoreSnapshot(snapshotRoot, result.snapshotId);
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

  restoreSnapshot(snapshotRoot, result.snapshotId);
  assert.equal(readFileSync(codexPath, 'utf8'), 'changed by hand');
});

test('a link to another file is reported as external-link, a dangling one as broken', () => {
  const external = join(root, 'elsewhere.md');
  writeFileSync(external, 'other');
  rmSync(targets[0]?.path as string, { force: true });
  symlinkSync(external, targets[0]?.path as string, 'file');

  let report = scanPrompts(source, targets);
  assert.equal(report.targets[0]?.state, 'external-link');

  rmSync(targets[0]?.path as string, { force: true });
  const gone = join(root, 'gone.md');
  writeFileSync(gone, 'x');
  symlinkSync(gone, targets[0]?.path as string, 'file');
  rmSync(gone, { force: true });

  report = scanPrompts(source, targets);
  assert.equal(report.targets[0]?.state, 'broken');
});

test('align refuses an unknown agent', () => {
  assert.throws(() => alignPrompt({ source, snapshotRoot, targets }, 'nope'), /未知的 agent/);
});
