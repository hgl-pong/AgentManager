import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

import type { AgentReport, AgentSpec, Cell, Matrix, Row, ScanInput } from '../shared/types.ts';

export type { AgentReport, AgentSpec, Cell, CellState, Matrix, Row, ScanInput } from '../shared/types.ts';

function listDir(dir: string): Dirent[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function hashBytes(input: Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** A directory only counts as a skill when it carries a SKILL.md; container dirs like Codex's `.system` are skipped. */
export function hasSkillFile(dir: string): boolean {
  try {
    return statSync(join(dir, 'SKILL.md')).isFile();
  } catch {
    return false;
  }
}

/** Content hash of a skill directory: every file's relative path plus its bytes. Symlinks are skipped so a link loop cannot hang the scan. */
export function hashDir(dir: string): string {
  const entries: string[] = [];

  const walk = (current: string, prefix: string): void => {
    for (const child of listDir(current) ?? []) {
      if (child.isSymbolicLink()) continue;
      const rel = prefix === '' ? child.name : `${prefix}/${child.name}`;
      const abs = join(current, child.name);
      if (child.isDirectory()) walk(abs, rel);
      else if (child.isFile()) entries.push(`${rel}:${hashBytes(readFileSync(abs))}`);
    }
  };

  walk(dir, '');
  entries.sort();
  return hashBytes(Buffer.from(entries.join('\n')));
}

/** Separator form for comparison: Windows accepts both slashes, POSIX keeps its exact bytes. */
function normalizePath(value: string, caseInsensitive: boolean): string {
  let normalized: string;
  if (process.platform === 'win32') {
    const unified = value.replaceAll('/', '\\');
    normalized = /^[A-Za-z]:\\?$/.test(unified) ? `${unified.slice(0, 2)}\\` : unified.replace(/\\+$/, '');
  } else {
    normalized = value === '/' ? '/' : value.replace(/\/+$/, '');
  }
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

/**
 * True when `child` lives strictly under `parent`; a child equal to the parent is not inside.
 * Case folding happens only where the filesystem ignores case (Windows by default). Exported so
 * the static-file guard shares the same comparison as the skill scan.
 */
export function isInside(
  child: string,
  parent: string,
  caseInsensitive = process.platform === 'win32',
): boolean {
  const parentPath = normalizePath(parent, caseInsensitive);
  const childPath = normalizePath(child, caseInsensitive);
  if (childPath === parentPath) return false;
  const separator = process.platform === 'win32' ? '\\' : '/';
  const prefix = /[\\/]$/.test(parentPath) ? parentPath : `${parentPath}${separator}`;
  return childPath.startsWith(prefix);
}

export function scanMatrix(input: ScanInput): Matrix {
  const sourceSkills = (listDir(input.source) ?? [])
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .filter((entry) => hasSkillFile(join(input.source, entry.name)))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const sourceSet = new Set(sourceSkills);

  const sourceHashes = new Map<string, string>();
  const sourceHash = (name: string): string => {
    let hash = sourceHashes.get(name);
    if (hash === undefined) {
      hash = hashDir(join(input.source, name));
      sourceHashes.set(name, hash);
    }
    return hash;
  };

  const agents: AgentReport[] = [];
  const cellsByAgent = new Map<string, Map<string, Cell>>();

  for (const agent of input.agents) {
    const entries = listDir(agent.root);
    agents.push({ ...agent, detected: entries !== null });
    const cells = new Map<string, Cell>();

    for (const entry of entries ?? []) {
      const abs = join(agent.root, entry.name);

      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(abs);
        } catch {
          // A dangling link cannot be verified, but it is exactly what this page exists to surface.
          cells.set(entry.name, { state: 'broken', path: abs });
          continue;
        }
        if (!hasSkillFile(target)) continue;
        cells.set(entry.name, {
          state: isInside(target, input.source) ? 'linked' : 'external',
          path: abs,
          target,
        });
        continue;
      }

      if (entry.isDirectory()) {
        if (!hasSkillFile(abs)) continue;
        cells.set(
          entry.name,
          sourceSet.has(entry.name)
            ? { state: 'copy', path: abs, hashMatch: sourceHash(entry.name) === hashDir(abs) }
            : { state: 'orphan', path: abs },
        );
      }
    }

    cellsByAgent.set(agent.key, cells);
  }

  const names = new Set(sourceSkills);
  for (const cells of cellsByAgent.values()) {
    for (const name of cells.keys()) names.add(name);
  }

  const rows: Row[] = [...names]
    .map((name) => {
      const cells: Record<string, Cell> = {};
      for (const agent of agents) {
        cells[agent.key] = cellsByAgent.get(agent.key)?.get(name) ?? { state: 'missing' };
      }
      return { name, inSource: sourceSet.has(name), cells };
    })
    .sort((a, b) => Number(b.inSource) - Number(a.inSource) || a.name.localeCompare(b.name));

  return { source: { path: input.source, skills: sourceSkills }, agents, rows };
}
