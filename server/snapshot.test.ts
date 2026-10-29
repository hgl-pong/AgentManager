import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createSnapshot, listSnapshots, markSnapshotFailed, restoreSnapshot } from './snapshot.ts';
import { AppError } from '../shared/types.ts';

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

function isAppError(status: number) {
  return (error: unknown) => error instanceof AppError && error.status === status;
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

  const report = restoreSnapshot(snapshotRoot(), manifest.id, [workspace]);

  assert.deepEqual(report.restored, [dir]);
  assert.equal(readFileSync(join(dir, 'file.txt'), 'utf8'), 'before');
  assert.equal(existsSync(join(dir, 'extra.txt')), false);
});

test('restoreSnapshot removes what the operation created', () => {
  const created = join(workspace, 'new-link');
  const manifest = createSnapshot(snapshotRoot(), 'test-created', [], [created]);
  mkdirSync(created, { recursive: true });

  const report = restoreSnapshot(snapshotRoot(), manifest.id, [workspace]);

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
  assert.equal(manifest.entries[0]?.linkType, 'junction');

  rmSync(link, { recursive: true, force: true });
  restoreSnapshot(snapshotRoot(), manifest.id, [workspace]);

  assert.equal(existsSync(link), true);
  assert.equal(realpathSync(link), realpathSync(target));
});

test('a file symlink is recorded as a file link, not a junction', (t) => {
  const target = join(workspace, 'file-target.txt');
  writeFileSync(target, 'target v1');
  const link = join(workspace, 'file-link.txt');
  try {
    symlinkSync(target, link, 'file');
  } catch {
    t.skip('file symlinks need developer mode on this machine');
    return;
  }

  const manifest = createSnapshot(snapshotRoot(), 'test-file-link', [link]);
  assert.equal(manifest.entries[0]?.kind, 'link');
  assert.equal(manifest.entries[0]?.linkType, 'file');

  rmSync(link, { force: true });
  const report = restoreSnapshot(snapshotRoot(), manifest.id, [workspace]);

  assert.deepEqual(report.restored, [link]);
  assert.equal(realpathSync(link), realpathSync(target));
});

test('paths that do not exist are not recorded', () => {
  const manifest = createSnapshot(snapshotRoot(), 'test-missing', [join(workspace, 'nope')]);
  assert.equal(manifest.entries.length, 0);
});

test('a restore snapshots the live state first and can itself be undone', () => {
  const file = join(workspace, 'undo.txt');
  writeFileSync(file, 'v2');
  const saveV3 = createSnapshot(snapshotRoot(), 'prompts save', [file]);
  writeFileSync(file, 'v3');

  const restore = restoreSnapshot(snapshotRoot(), saveV3.id, [workspace]);
  assert.equal(readFileSync(file, 'utf8'), 'v2');
  assert.ok(restore.snapshotId && restore.snapshotId !== saveV3.id);

  restoreSnapshot(snapshotRoot(), restore.snapshotId, [workspace]);
  assert.equal(readFileSync(file, 'utf8'), 'v3');
});

test('undoing a restore also removes files that the restore brought back', () => {
  const file = join(workspace, 'recreated.txt');
  writeFileSync(file, 'gone-v1');
  const manifest = createSnapshot(snapshotRoot(), 'before delete', [file]);
  rmSync(file);

  const restore = restoreSnapshot(snapshotRoot(), manifest.id, [workspace]);
  assert.equal(readFileSync(file, 'utf8'), 'gone-v1');

  restoreSnapshot(snapshotRoot(), restore.snapshotId, [workspace]);
  assert.equal(existsSync(file), false);
});

test('a missing backup never deletes live content', () => {
  const file = join(workspace, 'backup-gone.txt');
  writeFileSync(file, 'live v2');
  const manifest = createSnapshot(snapshotRoot(), 'test-backup-gone', [file]);
  const stored = manifest.entries[0]?.storedPath;
  assert.ok(stored);
  rmSync(stored, { force: true });

  const report = restoreSnapshot(snapshotRoot(), manifest.id, [workspace]);

  assert.equal(readFileSync(file, 'utf8'), 'live v2');
  assert.deepEqual(report.restored, []);
  assert.deepEqual(report.missing, [file]);
});

test('snapshot ids stay unique when two snapshots share a timestamp', () => {
  const now = new Date('2022-01-02T03:04:05Z');
  const first = createSnapshot(snapshotRoot(), 'same-second-a', [], [], now);
  const second = createSnapshot(snapshotRoot(), 'same-second-b', [], [], now);

  assert.notEqual(first.id, second.id);
});

test('a failed operation marks its snapshot instead of deleting it', () => {
  const manifest = createSnapshot(snapshotRoot(), 'link agent/skill', []);
  markSnapshotFailed(snapshotRoot(), manifest.id);

  const listed = listSnapshots(snapshotRoot()).find((candidate) => candidate.id === manifest.id);
  assert.equal(listed?.operation, '[失败] link agent/skill');
});

test('restore rejects an id that could leave the snapshot root', () => {
  assert.throws(() => restoreSnapshot(snapshotRoot(), '../outside', [workspace]), isAppError(400));
  assert.throws(() => restoreSnapshot(snapshotRoot(), 'a..b', [workspace]), isAppError(400));
  assert.throws(() => restoreSnapshot(snapshotRoot(), '', [workspace]), isAppError(400));
});

test('restore refuses manifest paths outside the allowed roots, entries and created alike', () => {
  const inside = join(workspace, 'guarded.txt');
  writeFileSync(inside, 'keep');
  const outside = join(root, 'outside.txt');
  writeFileSync(outside, 'safe');

  const entryManifest = createSnapshot(snapshotRoot(), 'test-guard-entry', [inside]);
  const entryPath = join(snapshotRoot(), entryManifest.id, 'manifest.json');
  const entryData = JSON.parse(readFileSync(entryPath, 'utf8')) as { entries: { originalPath: string }[] };
  entryData.entries[0]!.originalPath = outside;
  writeFileSync(entryPath, JSON.stringify(entryData));
  assert.throws(() => restoreSnapshot(snapshotRoot(), entryManifest.id, [workspace]), isAppError(400));
  assert.equal(readFileSync(outside, 'utf8'), 'safe');

  const createdManifest = createSnapshot(snapshotRoot(), 'test-guard-created', [], [outside]);
  assert.throws(() => restoreSnapshot(snapshotRoot(), createdManifest.id, [workspace]), isAppError(400));
  assert.equal(readFileSync(outside, 'utf8'), 'safe');
});

test('a malformed manifest is skipped by list and rejected by restore', () => {
  const id = 'malformed-manifest';
  mkdirSync(join(snapshotRoot(), id), { recursive: true });
  writeFileSync(
    join(snapshotRoot(), id, 'manifest.json'),
    JSON.stringify({ id, createdAt: '2023-01-01T00:00:00.000Z', operation: 'x', entries: 'nope', created: [] }),
  );

  assert.equal(
    listSnapshots(snapshotRoot()).some((manifest) => manifest.id === id),
    false,
  );
  assert.throws(() => restoreSnapshot(snapshotRoot(), id, [workspace]), isAppError(400));
});

test('listSnapshots returns newest first and skips a corrupt snapshot', () => {
  const older = createSnapshot(snapshotRoot(), 'older', [], [], new Date('2020-01-01T00:00:00Z'));
  const newer = createSnapshot(snapshotRoot(), 'newer', [], [], new Date('2021-01-01T00:00:00Z'));
  mkdirSync(join(snapshotRoot(), 'broken'), { recursive: true });
  writeFileSync(join(snapshotRoot(), 'broken', 'manifest.json'), '{not json');

  const ids = listSnapshots(snapshotRoot()).map((manifest) => manifest.id);

  assert.ok(ids.indexOf(newer.id) < ids.indexOf(older.id));
  assert.equal(ids.length, readdirSync(snapshotRoot()).length - 2);
});
