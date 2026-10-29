import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { createSnapshot } from './snapshot.ts';

import type { PromptActionReport, PromptLink, PromptsReport, PromptTargetSpec } from '../shared/types.ts';

export type {
  PromptActionReport,
  PromptLink,
  PromptsReport,
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
    throw new Error('既没有源文件，也没有可迁移的提示词内容');
  }

  const snapshot = createSnapshot(
    input.snapshotRoot,
    'prompts init',
    input.targets.map((target) => target.path),
    existing === null ? [input.source] : [],
  );

  if (existing === null) {
    mkdirSync(dirname(input.source), { recursive: true });
    writeFileSync(input.source, primaryText ?? '');
  }

  for (const target of input.targets) {
    mkdirSync(dirname(target.path), { recursive: true });
    linkFile(input.source, target.path);
  }

  return {
    action: 'init',
    snapshotId: snapshot.id,
    message: `已建立单一源 ${input.source}，${input.targets.length} 个 agent 的提示词指向它`,
    report: scanPrompts(input.source, input.targets),
  };
}

/** Re-points one target at the source, backing the old file up first. */
export function alignPrompt(input: PromptActionInput, key: string): PromptActionReport {
  const target = input.targets.find((candidate) => candidate.key === key);
  if (!target) throw new Error(`未知的 agent：${key}`);
  if (!existsSync(input.source)) throw new Error('源文件还不存在，先执行初始化');

  const snapshot = createSnapshot(input.snapshotRoot, `prompts align ${target.label}`, [target.path]);
  mkdirSync(dirname(target.path), { recursive: true });
  linkFile(input.source, target.path);

  return {
    action: 'align',
    snapshotId: snapshot.id,
    message: `已让 ${target.label} 的提示词指向单一源`,
    report: scanPrompts(input.source, input.targets),
  };
}
