import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { importSkill, linkSkill, moveDirectory, removeSkill, unlinkSkill } from './actions.ts';
import { listSnapshots, restoreSnapshot } from './snapshot.ts';
import { AppError } from '../shared/types.ts';

let root: string;
let source: string;
let agentRoot: string;
let snapshotRoot: string;

function writeSkill(dir: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-manager-act-'));
  source = join(root, 'source');
  agentRoot = join(root, 'agent', 'skills');
  snapshotRoot = join(root, 'snapshots');
  mkdirSync(agentRoot, { recursive: true });
  writeSkill(join(source, 'shared'), 'shared-v1');
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const input = (name: string) => ({ source, agentRoot, agentLabel: 'TestAgent', name, snapshotRoot });
const allowedRoots = () => [source, agentRoot];

test('linkSkill points the agent at the source skill', () => {
  const report = linkSkill(input('shared'));
  assert.equal(report.action, 'link');
  assert.equal(realpathSync(join(agentRoot, 'shared')), realpathSync(join(source, 'shared')));
  assert.ok(report.snapshotId.length > 0);

  restoreSnapshot(snapshotRoot, report.snapshotId, allowedRoots());
  assert.equal(existsSync(join(agentRoot, 'shared')), false);
});

test('linkSkill refuses a name the source does not have', () => {
  assert.throws(() => linkSkill(input('nope')), /源里没有/);
});

test('linkSkill refuses to overwrite an existing entry', () => {
  writeSkill(join(source, 'taken'), 'v1');
  writeSkill(join(agentRoot, 'taken'), 'local');
  assert.throws(() => linkSkill(input('taken')), /已存在/);
});

test('linkSkill refuses path traversal names', () => {
  assert.throws(() => linkSkill(input('../escape')), /路径分隔符/);
});

test('importSkill moves a copy into the source and links back', () => {
  writeSkill(join(agentRoot, 'local-only'), 'local-v1');

  const report = importSkill(input('local-only'));

  assert.equal(report.action, 'import');
  assert.equal(readFileSync(join(source, 'local-only', 'SKILL.md'), 'utf8'), 'local-v1');
  assert.equal(realpathSync(join(agentRoot, 'local-only')), realpathSync(join(source, 'local-only')));

  restoreSnapshot(snapshotRoot, report.snapshotId, allowedRoots());

  assert.equal(existsSync(join(source, 'local-only')), false);
  assert.equal(readFileSync(join(agentRoot, 'local-only', 'SKILL.md'), 'utf8'), 'local-v1');
});

test('importSkill refuses when the source already has that skill', () => {
  writeSkill(join(agentRoot, 'dup'), 'x');
  writeSkill(join(source, 'dup'), 'y');
  assert.throws(() => importSkill(input('dup')), /源里已经有/);
});

test('importSkill refuses a path that is already a link', () => {
  writeSkill(join(source, 'linked'), 'v1');
  symlinkSync(join(source, 'linked'), join(agentRoot, 'linked'), 'junction');
  assert.throws(() => importSkill(input('linked')), /已经是链接/);
});

test('removeSkill drops a copy but the snapshot can restore it', () => {
  writeSkill(join(agentRoot, 'stale'), 'stale-v1');

  const report = removeSkill(input('stale'));
  assert.equal(existsSync(join(agentRoot, 'stale')), false);

  restoreSnapshot(snapshotRoot, report.snapshotId, allowedRoots());
  assert.equal(readFileSync(join(agentRoot, 'stale', 'SKILL.md'), 'utf8'), 'stale-v1');
});

test('removeSkill refuses links', () => {
  writeSkill(join(source, 'keep'), 'v1');
  symlinkSync(join(source, 'keep'), join(agentRoot, 'keep'), 'junction');
  assert.throws(() => removeSkill(input('keep')), /是链接/);
});

test('unlinkSkill removes a dangling link and the snapshot puts it back', () => {
  const target = join(root, 'deleted-target');
  const dangling = join(agentRoot, 'ghost');
  symlinkSync(target, dangling, 'junction');
  assert.equal(lstatSync(dangling).isSymbolicLink(), true);

  const report = unlinkSkill(input('ghost'));
  assert.equal(report.action, 'unlink');
  assert.throws(() => lstatSync(dangling));

  restoreSnapshot(snapshotRoot, report.snapshotId, allowedRoots());
  assert.equal(lstatSync(dangling).isSymbolicLink(), true);
  assert.equal(readlinkSync(dangling), target);
});

test('unlinkSkill refuses a real directory and a missing name', () => {
  writeSkill(join(agentRoot, 'plain'), 'v1');
  assert.throws(() => unlinkSkill(input('plain')), /不是链接/);
  assert.throws(() => unlinkSkill(input('absent')), /里没有/);
});

const isStatus = (status: number) => (error: unknown) => error instanceof AppError && error.status === status;

test('skill actions carry 400/404/409 statuses', () => {
  assert.throws(() => linkSkill(input('nope')), isStatus(404));
  assert.throws(() => linkSkill(input('taken')), isStatus(409));
  assert.throws(() => removeSkill(input('keep')), isStatus(409));
  assert.throws(() => unlinkSkill(input('plain')), isStatus(409));
  assert.throws(() => linkSkill(input('../escape')), isStatus(400));
});

test('an action that throws keeps its snapshot, marked as failed', () => {
  // A file where the agent root should be makes the write after the snapshot fail.
  const blockedRoot = join(root, 'blocked-root');
  writeFileSync(blockedRoot, 'not a directory');
  const before = listSnapshots(snapshotRoot).length;

  assert.throws(
    () => linkSkill({ source, agentRoot: blockedRoot, agentLabel: 'Blocked', name: 'shared', snapshotRoot }),
  );

  const snapshots = listSnapshots(snapshotRoot);
  assert.equal(snapshots.length, before + 1);
  assert.ok(snapshots.some((snapshot) => snapshot.operation === '[失败] link Blocked/shared'));
});

test('a failed import leaves the agent copy untouched', () => {
  const localAgent = join(root, 'local-agent');
  writeSkill(join(localAgent, 'precious'), 'precious-v1');
  const blockedSource = join(root, 'blocked-source');
  writeFileSync(blockedSource, 'not a directory');

  assert.throws(() =>
    importSkill({
      source: join(blockedSource, 'skills'),
      agentRoot: localAgent,
      agentLabel: 'Blocked',
      name: 'precious',
      snapshotRoot,
    }),
  );

  assert.equal(readFileSync(join(localAgent, 'precious', 'SKILL.md'), 'utf8'), 'precious-v1');
  assert.equal(existsSync(join(blockedSource, 'skills')), false);
});

test('a failed move keeps the source and leaves no partial destination', () => {
  const from = join(root, 'move-from');
  writeSkill(from, 'move-v1');
  const blocker = join(root, 'move-blocker');
  writeFileSync(blocker, 'not a directory');

  assert.throws(() => moveDirectory(from, join(blocker, 'child')));

  assert.equal(readFileSync(join(from, 'SKILL.md'), 'utf8'), 'move-v1');
  assert.equal(existsSync(join(blocker, 'child')), false);
});
