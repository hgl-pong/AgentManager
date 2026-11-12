import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { AppError } from '../shared/types.ts';
import { createSnapshot, markSnapshotFailed } from './snapshot.ts';
import { hasSkillFile } from './scan.ts';

import type { SkillActionKind } from '../shared/types.ts';

export type { SkillActionKind } from '../shared/types.ts';

export interface SkillActionInput {
  source: string;
  agentRoot: string;
  agentLabel: string;
  name: string;
  snapshotRoot: string;
}

export interface DeleteSkillInput {
  source: string;
  agents: Array<{ root: string; label: string }>;
  name: string;
  snapshotRoot: string;
}

export interface SkillActionReport {
  action: SkillActionKind;
  name: string;
  agent: string;
  snapshotId: string;
  message: string;
}

function assertSafeName(name: string): void {
  if (name.length === 0 || name === '.' || name === '..') throw new AppError(400, '非法的 skill 名');
  if (name.includes('/') || name.includes('\\')) throw new AppError(400, 'skill 名不能包含路径分隔符');
}

function assertInside(parent: string, child: string): void {
  if (!child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)) {
    throw new AppError(400, `路径越界：${child}`);
  }
}

/**
 * Moves a directory, never leaving a half-written destination behind: a failed copy removes the
 * partial destination, and a source that cannot be removed removes the copy it just made.
 * Exported for tests of the rollback path.
 */
export function moveDirectory(from: string, to: string): void {
  try {
    renameSync(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }

  try {
    cpSync(from, to, { recursive: true });
  } catch (error) {
    rmSync(to, { recursive: true, force: true });
    throw error;
  }

  try {
    rmSync(from, { recursive: true, force: true });
  } catch (error) {
    rmSync(to, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Points an agent at the source skill. Nothing is overwritten: an existing entry at the
 * target path is an error, because deciding between a copy, a link and a broken link is
 * not something this action may guess.
 */
export function linkSkill(input: SkillActionInput): SkillActionReport {
  assertSafeName(input.name);
  const sourcePath = join(input.source, input.name);
  if (!hasSkillFile(sourcePath)) throw new AppError(404, `源里没有可链接的 skill：${input.name}`);

  const target = join(input.agentRoot, input.name);
  assertInside(input.agentRoot, target);
  if (existsSync(target) || lstatOrNull(target)) {
    throw new AppError(409, `${input.agentLabel} 里已存在 ${input.name}`);
  }

  const snapshot = createSnapshot(input.snapshotRoot, `link ${input.agentLabel}/${input.name}`, [], [target]);
  try {
    mkdirSync(input.agentRoot, { recursive: true });
    symlinkSync(sourcePath, target, 'junction');
  } catch (error) {
    markSnapshotFailed(input.snapshotRoot, snapshot.id);
    throw error;
  }

  return {
    action: 'link',
    name: input.name,
    agent: input.agentLabel,
    snapshotId: snapshot.id,
    message: `已把 ${input.name} 链接到 ${input.agentLabel}`,
  };
}

/**
 * Moves an agent-local copy into the source, then links the agent path at the source.
 * The original directory is backed up first, so a restore puts the standalone copy back.
 */
export function importSkill(input: SkillActionInput): SkillActionReport {
  assertSafeName(input.name);
  const agentPath = join(input.agentRoot, input.name);
  assertInside(input.agentRoot, agentPath);

  if (!hasSkillFile(agentPath)) throw new AppError(404, `${input.agentLabel} 里没有独立的 ${input.name} 目录`);
  if (lstatOrNull(agentPath)?.isSymbolicLink()) throw new AppError(409, `${input.name} 已经是链接，无需导入`);

  const sourcePath = join(input.source, input.name);
  assertInside(input.source, sourcePath);
  if (existsSync(sourcePath)) throw new AppError(409, `源里已经有 ${input.name}，不能导入同名 skill`);

  const snapshot = createSnapshot(input.snapshotRoot, `import ${input.agentLabel}/${input.name}`, [agentPath], [
    sourcePath,
  ]);
  try {
    mkdirSync(input.source, { recursive: true });
    moveDirectory(agentPath, sourcePath);
    try {
      symlinkSync(sourcePath, agentPath, 'junction');
    } catch (error) {
      // The link could not be built, so put the directory back where it came from.
      try {
        moveDirectory(sourcePath, agentPath);
      } catch {
        // The snapshot still holds the copy; the original error is the one worth reporting.
      }
      throw error;
    }
  } catch (error) {
    markSnapshotFailed(input.snapshotRoot, snapshot.id);
    throw error;
  }

  return {
    action: 'import',
    name: input.name,
    agent: input.agentLabel,
    snapshotId: snapshot.id,
    message: `已把 ${input.name} 收进源，并让 ${input.agentLabel} 链接到它`,
  };
}

/** Removes a standalone copy from an agent directory. The copy lives on in the snapshot. */
export function removeSkill(input: SkillActionInput): SkillActionReport {
  assertSafeName(input.name);
  const agentPath = join(input.agentRoot, input.name);
  assertInside(input.agentRoot, agentPath);

  const stat = lstatOrNull(agentPath);
  if (!stat) throw new AppError(404, `${input.agentLabel} 里没有 ${input.name}`);
  if (stat.isSymbolicLink()) throw new AppError(409, `${input.name} 是链接，不能用「移除副本」`);

  const snapshot = createSnapshot(input.snapshotRoot, `remove ${input.agentLabel}/${input.name}`, [agentPath]);
  try {
    rmSync(agentPath, { recursive: true, force: true });
  } catch (error) {
    markSnapshotFailed(input.snapshotRoot, snapshot.id);
    throw error;
  }

  return {
    action: 'remove',
    name: input.name,
    agent: input.agentLabel,
    snapshotId: snapshot.id,
    message: `已移除 ${input.agentLabel} 里的 ${input.name}，快照 ${snapshot.id} 可还原`,
  };
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Removes a link entry from an agent directory. Its main use is a dangling link the scan
 * reports as broken, which otherwise has no repair path; the link is recorded in the snapshot.
 */
export function unlinkSkill(input: SkillActionInput): SkillActionReport {
  assertSafeName(input.name);
  const agentPath = join(input.agentRoot, input.name);
  assertInside(input.agentRoot, agentPath);

  const stat = lstatOrNull(agentPath);
  if (!stat) throw new AppError(404, `${input.agentLabel} 里没有 ${input.name}`);
  if (!stat.isSymbolicLink()) throw new AppError(409, `${input.name} 不是链接，不能用「移除坏链」`);

  const snapshot = createSnapshot(input.snapshotRoot, `unlink ${input.agentLabel}/${input.name}`, [agentPath]);
  try {
    unlinkSync(agentPath);
  } catch (error) {
    markSnapshotFailed(input.snapshotRoot, snapshot.id);
    throw error;
  }

  return {
    action: 'unlink',
    name: input.name,
    agent: input.agentLabel,
    snapshotId: snapshot.id,
    message: `已移除 ${input.agentLabel} 里的 ${input.name} 链接，快照 ${snapshot.id} 可还原`,
  };
}

/** Comparison form for link targets: Windows compares case-insensitively and accepts both separators. */
function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const unified = process.platform === 'win32' ? value.replaceAll('/', '\\') : value;
    const trimmed = unified.replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  };
  return normalize(left) === normalize(right);
}

/** The target a link points at, even when the link is dangling and realpath cannot resolve it. */
function linkTargetOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    try {
      const raw = readlinkSync(path);
      return isAbsolute(raw) ? raw : resolve(dirname(path), raw);
    } catch {
      return null;
    }
  }
}

/**
 * Deletes a skill from the single source and removes the links that point at it. Independent
 * copies and links that point somewhere else are deliberately kept: they are not this source
 * entry, and silently deleting them would discard content the user did not select.
 */
export function deleteSourceSkill(input: DeleteSkillInput): SkillActionReport {
  assertSafeName(input.name);
  const sourcePath = join(input.source, input.name);
  assertInside(input.source, sourcePath);

  const sourceStat = lstatOrNull(sourcePath);
  if (!sourceStat || !hasSkillFile(sourcePath)) {
    throw new AppError(404, `源里没有这个 skill：${input.name}`);
  }

  // A source entry can itself be a link; compare agent links against both the entry and its target.
  const sourceTargets = new Set([sourcePath]);
  try {
    sourceTargets.add(realpathSync(sourcePath));
  } catch {
    // A dangling source link has no realpath; the raw path above is the only identity.
  }

  const removable: Array<{ path: string; label: string }> = [];
  let kept = 0;
  for (const agent of input.agents) {
    const agentPath = join(agent.root, input.name);
    assertInside(agent.root, agentPath);
    const stat = lstatOrNull(agentPath);
    if (!stat) continue;

    if (!stat.isSymbolicLink()) {
      kept += 1;
      continue;
    }
    const target = linkTargetOf(agentPath);
    if (target !== null && [...sourceTargets].some((candidate) => samePath(target, candidate))) {
      removable.push({ path: agentPath, label: agent.label });
    } else {
      kept += 1;
    }
  }

  const snapshot = createSnapshot(input.snapshotRoot, `delete ${input.name}`, [
    sourcePath,
    ...removable.map((entry) => entry.path),
  ]);
  try {
    for (const entry of removable) unlinkSync(entry.path);
    if (sourceStat.isSymbolicLink()) unlinkSync(sourcePath);
    else rmSync(sourcePath, { recursive: true, force: true });
  } catch (error) {
    markSnapshotFailed(input.snapshotRoot, snapshot.id);
    throw error;
  }

  const linkNote =
    removable.length > 0
      ? `，移除 ${removable.length} 个链接（${removable.map((entry) => entry.label).join('、')}）`
      : '';
  const keptNote = kept > 0 ? `；保留 ${kept} 个独立副本或外部链接` : '';
  return {
    action: 'delete',
    name: input.name,
    agent: '源',
    snapshotId: snapshot.id,
    message: `已从源删除 ${input.name}${linkNote}${keptNote} · 快照 ${snapshot.id} 可还原`,
  };
}
