import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { AppError } from '../shared/types.ts';
import type { AgentSpec } from '../shared/types.ts';
import { installBuiltinSkill, listBuiltinSkills } from './builtins.ts';
import { restoreSnapshot } from './snapshot.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

interface Fixture {
  root: string;
  source: string;
  snapshotRoot: string;
  tempRoot: string;
  agents: AgentSpec[];
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agent-manager-builtin-'));
  return {
    root,
    source: join(root, 'source'),
    snapshotRoot: join(root, 'snapshots'),
    tempRoot: join(root, 'tmp'),
    agents: [
      { key: 'claude', label: 'Claude Code', root: join(root, 'agents', 'claude') },
      { key: 'codex', label: 'Codex', root: join(root, 'agents', 'codex') },
    ],
  };
}

test('listBuiltinSkills carries the whole preview and follows the source', () => {
  const fixture = makeFixture();
  try {
    const before = listBuiltinSkills({ source: fixture.source, projectRoot: PROJECT_ROOT });
    const skillify = before.items.find((item) => item.slug === 'skillify');
    assert.ok(skillify, 'skillify ships with the app');
    assert.equal(skillify.id, 'builtin:skillify');
    assert.equal(skillify.builtin, true);
    assert.equal(skillify.inSource, false);
    assert.equal(skillify.license, 'MIT');
    assert.ok(skillify.files.some((file) => file.path === 'SKILL.md'));
    assert.ok(skillify.capabilities.length > 0);
    const cpp = before.items.find((item) => item.slug === 'cpp-windows-debug');
    assert.ok(cpp, 'cpp-windows-debug ships with the app');
    assert.equal(cpp.builtin, true);
    assert.ok(cpp.files.some((file) => file.path === 'references/cdb-cheatsheet.md'));
    assert.equal(before.sourcePath, fixture.source);

    mkdirSync(join(fixture.source, 'skillify'), { recursive: true });
    writeFileSync(join(fixture.source, 'skillify', 'SKILL.md'), 'local copy\n');
    const after = listBuiltinSkills({ source: fixture.source, projectRoot: PROJECT_ROOT });
    assert.equal(after.items.find((item) => item.slug === 'skillify')?.inSource, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('installBuiltinSkill copies the bundled files into the source and links the agents', () => {
  const fixture = makeFixture();
  try {
    const result = installBuiltinSkill({
      source: fixture.source,
      snapshotRoot: fixture.snapshotRoot,
      tempRoot: fixture.tempRoot,
      agents: fixture.agents,
      projectRoot: PROJECT_ROOT,
      request: { name: 'skillify', agents: ['claude', 'codex'] },
    });

    const destination = join(fixture.source, 'skillify');
    assert.equal(result.name, 'skillify');
    assert.equal(result.path, destination);
    assert.equal(result.files, 2, 'SKILL.md and LICENSE');
    assert.match(readFileSync(join(destination, 'SKILL.md'), 'utf8'), /^---\nname: skillify/);
    assert.equal(existsSync(join(destination, 'LICENSE')), true);

    for (const agent of fixture.agents) {
      const link = join(agent.root, 'skillify');
      assert.equal(lstatSync(link).isSymbolicLink(), true);
      assert.equal(realpathSync(link), realpathSync(destination));
      assert.equal(statSync(join(link, 'SKILL.md')).isFile(), true);
    }

    // The snapshot puts the source and every agent back to the state before the install.
    const restored = restoreSnapshot(fixture.snapshotRoot, result.snapshotId, [
      fixture.source,
      ...fixture.agents.map((agent) => agent.root),
    ]);
    assert.equal(existsSync(destination), false);
    assert.deepEqual(
      restored.removed.sort(),
      [destination, ...fixture.agents.map((agent) => join(agent.root, 'skillify'))].sort(),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('installBuiltinSkill can copy without linking any agent', () => {
  const fixture = makeFixture();
  try {
    const result = installBuiltinSkill({
      source: fixture.source,
      snapshotRoot: fixture.snapshotRoot,
      tempRoot: fixture.tempRoot,
      agents: fixture.agents,
      projectRoot: PROJECT_ROOT,
      request: { name: 'skillify' },
    });
    assert.deepEqual(result.links, []);
    assert.equal(existsSync(join(fixture.source, 'skillify', 'SKILL.md')), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('installBuiltinSkill refuses a name the source already has', () => {
  const fixture = makeFixture();
  try {
    mkdirSync(join(fixture.source, 'skillify'), { recursive: true });
    assert.throws(
      () =>
        installBuiltinSkill({
          source: fixture.source,
          snapshotRoot: fixture.snapshotRoot,
          tempRoot: fixture.tempRoot,
          agents: fixture.agents,
          projectRoot: PROJECT_ROOT,
          request: { name: 'skillify' },
        }),
      (error) => error instanceof AppError && error.status === 409,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('installBuiltinSkill rejects an unknown skill or agent', () => {
  const fixture = makeFixture();
  try {
    const input = {
      source: fixture.source,
      snapshotRoot: fixture.snapshotRoot,
      tempRoot: fixture.tempRoot,
      agents: fixture.agents,
      projectRoot: PROJECT_ROOT,
    };
    assert.throws(
      () => installBuiltinSkill({ ...input, request: { name: 'nope' } }),
      (error) => error instanceof AppError && error.status === 404,
    );
    assert.throws(
      () => installBuiltinSkill({ ...input, request: { name: 'skillify', agents: ['nope'] } }),
      (error) => error instanceof AppError && error.status === 400,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('an exe asset map wins over the checkout, so the exe installs what it shipped', () => {
  const fixture = makeFixture();
  try {
    const assets = {
      'builtin-skills/skillify/SKILL.md': Buffer.from('---\nname: skillify\n---\nfrom the exe\n').toString(
        'base64',
      ),
      'builtin-skills/skillify/LICENSE': Buffer.from('MIT\n').toString('base64'),
    };
    installBuiltinSkill({
      source: fixture.source,
      snapshotRoot: fixture.snapshotRoot,
      tempRoot: fixture.tempRoot,
      agents: fixture.agents,
      projectRoot: join(fixture.root, 'missing-project'),
      assets,
      request: { name: 'skillify' },
    });
    assert.match(readFileSync(join(fixture.source, 'skillify', 'SKILL.md'), 'utf8'), /from the exe/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
