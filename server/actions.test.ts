import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { importSkill, linkSkill, removeSkill } from './actions.ts';
import { restoreSnapshot } from './snapshot.ts';

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

test('linkSkill points the agent at the source skill', () => {
  const report = linkSkill(input('shared'));
  assert.equal(report.action, 'link');
  assert.equal(realpathSync(join(agentRoot, 'shared')), realpathSync(join(source, 'shared')));
  assert.ok(report.snapshotId.length > 0);

  restoreSnapshot(snapshotRoot, report.snapshotId);
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

  restoreSnapshot(snapshotRoot, report.snapshotId);

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

  restoreSnapshot(snapshotRoot, report.snapshotId);
  assert.equal(readFileSync(join(agentRoot, 'stale', 'SKILL.md'), 'utf8'), 'stale-v1');
});

test('removeSkill refuses links', () => {
  writeSkill(join(source, 'keep'), 'v1');
  symlinkSync(join(source, 'keep'), join(agentRoot, 'keep'), 'junction');
  assert.throws(() => removeSkill(input('keep')), /是链接/);
});
