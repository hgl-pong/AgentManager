import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createSnapshot, listSnapshots, restoreSnapshot } from './snapshot.ts';

let root: string;
let workspace: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-manager-snap-'));
  workspace = join(root, 'live');
  mkdirSync(workspace, { recursive: true });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function snapshotRoot(): string {
  return join(root, 'snapshots');
}

test('createSnapshot copies a directory and a file without touching the originals', () => {
  const skill = join(workspace, 'skill-a');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), 'v1');
  const file = join(workspace, 'CLAUDE.md');
  writeFileSync(file, 'prompt v1');

  const manifest = createSnapshot(snapshotRoot(), 'test-copy', [skill, file]);

  assert.equal(manifest.entries.length, 2);
  assert.deepEqual(manifest.entries.map((entry) => entry.kind), ['dir', 'file']);
  const stored = manifest.entries[0]?.storedPath;
  assert.ok(stored && readFileSync(join(stored, 'SKILL.md'), 'utf8') === 'v1');
  assert.equal(readFileSync(join(skill, 'SKILL.md'), 'utf8'), 'v1');
});

test('restoreSnapshot brings modified content back', () => {
  const dir = join(workspace, 'restore-me');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'file.txt'), 'before');

  const manifest = createSnapshot(snapshotRoot(), 'test-restore', [dir]);
  writeFileSync(join(dir, 'file.txt'), 'after');
  writeFileSync(join(dir, 'extra.txt'), 'extra');

  const report = restoreSnapshot(snapshotRoot(), manifest.id);

  assert.deepEqual(report.restored, [dir]);
  assert.equal(readFileSync(join(dir, 'file.txt'), 'utf8'), 'before');
  assert.equal(existsSync(join(dir, 'extra.txt')), false);
});

test('restoreSnapshot removes what the operation created', () => {
  const created = join(workspace, 'new-link');
  const manifest = createSnapshot(snapshotRoot(), 'test-created', [], [created]);
  mkdirSync(created, { recursive: true });

  const report = restoreSnapshot(snapshotRoot(), manifest.id);

  assert.deepEqual(report.removed, [created]);
  assert.equal(existsSync(created), false);
});

test('links are recorded and recreated on restore', () => {
  const target = join(workspace, 'link-target');
  mkdirSync(target, { recursive: true });
  const link = join(workspace, 'link-here');
  symlinkSync(target, link, 'junction');

  const manifest = createSnapshot(snapshotRoot(), 'test-link', [link]);
  assert.equal(manifest.entries[0]?.kind, 'link');
  assert.equal(manifest.entries[0]?.storedPath, null);

  rmSync(link, { recursive: true, force: true });
  restoreSnapshot(snapshotRoot(), manifest.id);

  assert.equal(existsSync(link), true);
  assert.equal(realpathSync(link), realpathSync(target));
});

test('paths that do not exist are not recorded', () => {
  const manifest = createSnapshot(snapshotRoot(), 'test-missing', [join(workspace, 'nope')]);
  assert.equal(manifest.entries.length, 0);
});

test('listSnapshots returns newest first and skips a corrupt snapshot', () => {
  const older = createSnapshot(snapshotRoot(), 'older', [], [], new Date('2020-01-01T00:00:00Z'));
  const newer = createSnapshot(snapshotRoot(), 'newer', [], [], new Date('2021-01-01T00:00:00Z'));
  mkdirSync(join(snapshotRoot(), 'broken'), { recursive: true });
  writeFileSync(join(snapshotRoot(), 'broken', 'manifest.json'), '{not json');

  const ids = listSnapshots(snapshotRoot()).map((manifest) => manifest.id);

  assert.ok(ids.indexOf(newer.id) < ids.indexOf(older.id));
  assert.equal(ids.length, readdirSync(snapshotRoot()).length - 1);
});
