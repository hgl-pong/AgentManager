import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { AppError } from '../shared/types.ts';
import { createSnapshot, markSnapshotFailed } from './snapshot.ts';

import type {
  PromptActionReport,
  PromptLink,
  PromptsReport,
  PromptSaveReport,
  PromptSourceContent,
  PromptTargetSpec,
} from '../shared/types.ts';

export type {
  PromptActionReport,
  PromptLink,
  PromptsReport,
  PromptSaveReport,
  PromptSourceContent,
  PromptState,
  PromptTargetReport,
  PromptTargetSpec,
} from '../shared/types.ts';

export interface PromptActionInput {
  source: string;
  snapshotRoot: string;
  targets: PromptTargetSpec[];
  /** Used as the migration source during init; its content becomes the single source of truth. */
  primaryKey?: string;
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function isSameFile(a: string, b: string): boolean {
  try {
    const statA = statSync(a);
    const statB = statSync(b);
    return statA.ino === statB.ino && statA.dev === statB.dev;
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Reads the three prompt files without touching them. */
export function scanPrompts(source: string, targets: PromptTargetSpec[]): PromptsReport {
  const sourceText = readOrNull(source);
  const sourceHash = sourceText === null ? null : hashText(sourceText);

  return {
    source: {
      path: source,
      exists: sourceText !== null,
      ...(sourceText === null ? {} : { bytes: Buffer.byteLength(sourceText) }),
    },
    targets: targets.map((target) => {
      if (sourceText === null) return { ...target, state: 'no-source', link: 'none' };
      const text = readOrNull(target.path);
      if (text === null) {
        const link = isSymlink(target.path);
        return { ...target, state: link ? 'broken' : 'missing', link: link ? 'symlink' : 'none' };
      }

      const bytes = Buffer.byteLength(text);
      const link: PromptLink = isSymlink(target.path)
        ? 'symlink'
        : isSameFile(target.path, source)
          ? 'hardlink'
          : 'copy';

      let resolved: string | undefined;
      try {
        resolved = realpathSync(target.path);
      } catch {
        return { ...target, state: 'broken', link, bytes };
      }

      if (link === 'symlink') {
        return {
          ...target,
          state: resolved === realpathSync(source) ? 'synced' : 'external-link',
          link,
          bytes,
          target: resolved,
        };
      }

      return { ...target, state: hashText(text) === sourceHash ? 'synced' : 'drift', link, bytes };
    }),
  };
}

/** Replaces a target file with a hard link to the source, falling back to a symlink and then a copy. */
function linkFile(source: string, target: string): PromptLink {
  rmSync(target, { force: true });
  try {
    linkSync(source, target);
    return 'hardlink';
  } catch {
    try {
      symlinkSync(source, target, 'file');
      return 'symlink';
    } catch {
      copyFileSync(source, target);
      return 'copy';
    }
  }
}

/** Creates the single source from the primary target, then points every target at it. */
export function initPrompts(input: PromptActionInput): PromptActionReport {
  const primary = input.targets.find((target) => target.key === input.primaryKey) ?? input.targets[0];
  const primaryText = primary ? readOrNull(primary.path) : null;
  const existing = readOrNull(input.source);

  if (existing === null && primaryText === null) {
    throw new AppError(400, '既没有源文件，也没有可迁移的提示词内容');
  }

  // Targets that do not exist yet are created by this action, so a restore must delete them.
  const createdTargets = input.targets
    .filter((target) => lstatOrNull(target.path) === null)
    .map((target) => target.path);
  const snapshot = createSnapshot(input.snapshotRoot, 'prompts init', input.targets.map((target) => target.path), [
    ...(existing === null ? [input.source] : []),
    ...createdTargets,
  ]);

  try {
    if (existing === null) {
      mkdirSync(dirname(input.source), { recursive: true });
      writeFileSync(input.source, primaryText ?? '');
    }

    for (const target of input.targets) {
      mkdirSync(dirname(target.path), { recursive: true });
      linkFile(input.source, target.path);
    }
  } catch (error) {
    markSnapshotFailed(input.snapshotRoot, snapshot.id);
    throw error;
  }

  return {
    action: 'init',
    snapshotId: snapshot.id,
    message: `已建立单一源 ${input.source}，${input.targets.length} 个 agent 的提示词指向它`,
    report: scanPrompts(input.source, input.targets),
  };
}

/** Reads the canonical prompt text for the in-browser editor. Never writes. */
export function readPromptSource(source: string): PromptSourceContent {
  const content = readOrNull(source);
  const text = content ?? '';
  return {
    path: source,
    exists: content !== null,
    content: text,
    bytes: content === null ? 0 : Buffer.byteLength(content),
    // Absent files share one sentinel so "still absent" keeps matching.
    etag: content === null ? 'missing' : hashText(text),
  };
}

/**
 * Saves the canonical prompt in place. Writing in place (instead of rename) is required:
 * a rename would give the source a new inode and silently detach every hard-linked target.
 *
 * `expectedEtag` is the optimistic lock the editor read alongside its draft: when the file changed
 * on disk since then the write is refused with 409 instead of silently discarding that edit.
 */
export function savePromptSource(
  input: PromptActionInput,
  content: string,
  expectedEtag?: string,
): PromptSaveReport {
  if (Buffer.byteLength(content) > 1_000_000) throw new AppError(400, '提示词内容超过 1MB 上限');

  const stat = lstatOrNull(input.source);
  if (stat?.isSymbolicLink()) throw new AppError(409, '源文件是符号链接，为避免写到链接目标，拒绝保存');
  if (expectedEtag !== undefined) {
    const current = readPromptSource(input.source);
    if (current.etag !== expectedEtag) {
      throw new AppError(409, `${input.source} 已被外部修改，请先载入磁盘上的版本再保存`);
    }
  }

  const snapshot = createSnapshot(
    input.snapshotRoot,
    'prompts save',
    stat ? [input.source] : [],
    stat ? [] : [input.source],
    new Date(),
    { writeInPlace: true },
  );

  try {
    mkdirSync(dirname(input.source), { recursive: true });
    writeFileSync(input.source, content, 'utf8');
  } catch (error) {
    markSnapshotFailed(input.snapshotRoot, snapshot.id);
    throw error;
  }

  return {
    action: 'save',
    snapshotId: snapshot.id,
    message: '已保存单一源；硬链接目标立即生效',
    report: scanPrompts(input.source, input.targets),
    content: readPromptSource(input.source),
  };
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Re-points one target at the source, backing the old file up first. */
export function alignPrompt(input: PromptActionInput, key: string): PromptActionReport {
  const target = input.targets.find((candidate) => candidate.key === key);
  if (!target) throw new AppError(400, `未知的 agent：${key}`);
  if (!existsSync(input.source)) throw new AppError(409, '源文件还不存在，先执行初始化');

  // A target that does not exist yet is created here; restoring must remove it again.
  const existed = lstatOrNull(target.path) !== null;
  const snapshot = createSnapshot(input.snapshotRoot, `prompts align ${target.label}`, [target.path], existed ? [] : [target.path]);

  try {
    mkdirSync(dirname(target.path), { recursive: true });
    linkFile(input.source, target.path);
  } catch (error) {
    markSnapshotFailed(input.snapshotRoot, snapshot.id);
    throw error;
  }

  return {
    action: 'align',
    snapshotId: snapshot.id,
    message: `已让 ${target.label} 的提示词指向单一源`,
    report: scanPrompts(input.source, input.targets),
  };
}
