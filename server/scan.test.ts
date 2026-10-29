import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { hashDir, isInside, scanMatrix } from './scan.ts';
import type { Matrix } from '../shared/types.ts';

let root: string;
let source: string;
let matrix: Matrix;

/** Creates a skill directory with a SKILL.md, optional extra files included. */
function writeSkill(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-manager-'));
  source = join(root, 'source');
  const agentsRoot = join(root, 'agents');

  writeSkill(join(source, 'alpha'), { 'SKILL.md': 'alpha-v1' });
  writeSkill(join(source, 'beta'), { 'SKILL.md': 'beta-v1', 'notes.md': 'same' });
  // A container without SKILL.md is not a skill and must not become a row.
  writeSkill(join(source, 'container'), { 'README.md': 'not a skill' });
  // A link inside a skill must not make hashDir loop.
  symlinkSync(join(source, 'alpha'), join(source, 'alpha', 'loop'), 'junction');

  const claude = join(agentsRoot, 'claude');
  mkdirSync(claude, { recursive: true });
  symlinkSync(join(source, 'alpha'), join(claude, 'alpha'), 'junction');
  writeSkill(join(claude, 'beta'), { 'SKILL.md': 'beta-v1', 'notes.md': 'same' });

  const codex = join(agentsRoot, 'codex');
  mkdirSync(codex, { recursive: true });
  writeSkill(join(codex, 'beta'), { 'SKILL.md': 'beta-v2', 'notes.md': 'same' });
  writeSkill(join(codex, 'gamma'), { 'SKILL.md': 'gamma-v1' });
  writeSkill(join(codex, '.system'), { 'README.md': 'container of system skills' });

  const pi = join(agentsRoot, 'pi');
  mkdirSync(pi, { recursive: true });
  // Dangling junction: point at a real directory, then delete it.
  const gone = join(root, 'gone');
  writeSkill(join(gone, 'x'), { 'SKILL.md': 'x' });
  symlinkSync(gone, join(pi, 'ghost'), 'junction');
  rmSync(gone, { recursive: true, force: true });

  const external = join(root, 'external-delta');
  writeSkill(external, { 'SKILL.md': 'delta-v1' });
  symlinkSync(external, join(pi, 'delta'), 'junction');

  matrix = scanMatrix({
    source,
    agents: [
      { key: 'claude', label: 'Claude Code', root: claude },
      { key: 'codex', label: 'Codex', root: codex },
      { key: 'pi', label: 'pi', root: pi },
      { key: 'none', label: 'Absent', root: join(agentsRoot, 'does-not-exist') },
    ],
  });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const row = (name: string) => matrix.rows.find((candidate) => candidate.name === name);
const cell = (agent: string, name: string) => row(name)?.cells[agent];

test('source skills come from directories containing SKILL.md', () => {
  assert.deepEqual(matrix.source.skills, ['alpha', 'beta']);
});

test('container directories without SKILL.md never become rows', () => {
  assert.equal(row('container'), undefined);
  assert.equal(row('.system'), undefined);
});

test('a junction into the source is linked', () => {
  const alpha = cell('claude', 'alpha');
  assert.equal(alpha?.state, 'linked');
  assert.equal(row('alpha')?.inSource, true);
  assert.ok(alpha?.target?.endsWith(join('source', 'alpha')));
});

test('an identical copy is a copy whose hash matches the source', () => {
  const beta = cell('claude', 'beta');
  assert.equal(beta?.state, 'copy');
  assert.equal(beta?.hashMatch, true);
});

test('a modified copy is a copy whose hash differs from the source', () => {
  const beta = cell('codex', 'beta');
  assert.equal(beta?.state, 'copy');
  assert.equal(beta?.hashMatch, false);
});

test('a directory the source does not have is an orphan', () => {
  assert.equal(cell('codex', 'gamma')?.state, 'orphan');
  assert.equal(row('gamma')?.inSource, false);
});

test('a dangling junction is broken and carries no target', () => {
  const ghost = cell('pi', 'ghost');
  assert.equal(ghost?.state, 'broken');
  assert.equal(ghost?.target, undefined);
});

test('a link resolving outside the source is external', () => {
  const delta = cell('pi', 'delta');
  assert.equal(delta?.state, 'external');
  assert.ok(delta?.target?.includes('external-delta'));
});

test('a skill missing from an agent is reported as missing', () => {
  assert.equal(cell('pi', 'alpha')?.state, 'missing');
});

test('an absent agent directory is not detected and every cell is missing', () => {
  const absent = matrix.agents.find((agent) => agent.key === 'none');
  assert.equal(absent?.detected, false);
  for (const name of matrix.source.skills) {
    assert.equal(cell('none', name)?.state, 'missing');
  }
});

test('hashDir terminates when a skill contains a link back to itself', () => {
  assert.match(hashDir(join(source, 'alpha')), /^[0-9a-f]{64}$/);
});

test('containment rejects the parent itself and only folds case on Windows', () => {
  const parent = join(root, 'Source');
  assert.equal(isInside(parent, parent), false);
  assert.equal(isInside(join(root, 'Source', 'alpha'), parent), true);
  assert.equal(isInside(join(root, 'Other', 'alpha'), parent), false);

  const upperCase = join(root, 'SOURCE', 'alpha');
  if (process.platform === 'win32') {
    assert.equal(isInside(upperCase, parent), true);
    assert.equal(isInside(upperCase, parent, false), false);
    // Forward slashes are the same separator on Windows.
    assert.equal(isInside(`${parent.replaceAll('\\', '/')}/alpha`, parent), true);
  } else {
    assert.equal(isInside(upperCase, parent), false);
  }
});
