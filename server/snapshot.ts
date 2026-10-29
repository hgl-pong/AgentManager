import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { AppError } from '../shared/types.ts';
import type { RestoreReport, SnapshotEntry, SnapshotManifest } from '../shared/types.ts';

export type { RestoreReport, SnapshotEntry, SnapshotManifest } from '../shared/types.ts';

/** A snapshot id is also a directory name, so it may never traverse the snapshot root. */
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const ID_DOTS = '..';

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Comparison form for containment checks: a trailing separator never changes the directory. */
function normalizeForCompare(value: string): string {
  let trimmed = value.replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(trimmed)) trimmed = `${trimmed}${sep}`;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/** True when `child` is `parent` itself or lives under it. Windows paths compare case-insensitively. */
function isWithin(child: string, parent: string): boolean {
  const rel = relative(normalizeForCompare(parent), normalizeForCompare(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function newId(root: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = `${stamp}-${randomBytes(4).toString('hex')}`;
    if (!existsSync(join(root, id))) return id;
  }
  throw new Error(`无法生成不重复的快照 id：${stamp}`);
}

/** A link to a directory is recreated as a junction; a link to a file as a file link. */
function linkTypeFor(path: string): 'junction' | 'file' {
  try {
    return statSync(path).isDirectory() ? 'junction' : 'file';
  } catch {
    // A dangling link gives no clue; junction is the historical default and matches directories.
    return 'junction';
  }
}

export interface SnapshotOptions {
  /** Restoring overwrites regular files in place, preserving hard links to them. */
  writeInPlace?: boolean;
}

/** Backs up every existing path before an operation. Links are recorded, not copied. */
export function createSnapshot(
  root: string,
  operation: string,
  paths: string[],
  created: string[] = [],
  now = new Date(),
  options: SnapshotOptions = {},
): SnapshotManifest {
  const id = newId(root, now);
  const itemsDir = join(root, id, 'items');
  mkdirSync(itemsDir, { recursive: true });

  const entries: SnapshotEntry[] = [];
  paths.forEach((originalPath, index) => {
    const stat = lstatOrNull(originalPath);
    if (!stat) return;

    if (stat.isSymbolicLink()) {
      // realpath fails for a dangling link, so fall back to its raw target to keep it restorable.
      let linkTarget: string | undefined;
      try {
        linkTarget = realpathSync(originalPath);
      } catch {
        try {
          const raw = readlinkSync(originalPath);
          linkTarget = isAbsolute(raw) ? raw : resolve(dirname(originalPath), raw);
        } catch {
          // An unreadable link is reported as missing on restore.
        }
      }
      entries.push({
        originalPath,
        storedPath: null,
        kind: 'link',
        linkTarget,
        linkType: linkTypeFor(originalPath),
      });
      return;
    }

    const storedPath = join(itemsDir, `${String(index).padStart(2, '0')}-${basename(originalPath)}`);
    cpSync(originalPath, storedPath, { recursive: true });
    entries.push({ originalPath, storedPath, kind: stat.isDirectory() ? 'dir' : 'file' });
  });

  const manifest: SnapshotManifest = {
    id,
    createdAt: now.toISOString(),
    operation,
    entries,
    created,
    ...(options.writeInPlace ? { writeInPlace: true } : {}),
  };
  writeFileSync(join(root, id, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Marks a snapshot taken for an operation that then threw, so it never reads as a success. */
export function markSnapshotFailed(root: string, id: string): void {
  const manifestPath = join(root, id, 'manifest.json');
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SnapshotManifest;
    if (typeof manifest.operation !== 'string' || manifest.operation.startsWith('[失败]')) return;
    manifest.operation = `[失败] ${manifest.operation}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch {
    // The snapshot is already unreadable; there is nothing useful to annotate.
  }
}

function invalidManifest(id: string, detail: string): AppError {
  return new AppError(400, `快照 ${id} 的 manifest 无效：${detail}`);
}

function parseEntry(value: unknown, id: string): SnapshotEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidManifest(id, 'entries 项不是对象');
  const record = value as Record<string, unknown>;
  if (typeof record.originalPath !== 'string' || record.originalPath === '') {
    throw invalidManifest(id, 'entries[].originalPath 必须是字符串');
  }
  if (record.storedPath !== null && typeof record.storedPath !== 'string') {
    throw invalidManifest(id, 'entries[].storedPath 必须是字符串或 null');
  }
  if (record.kind !== 'file' && record.kind !== 'dir' && record.kind !== 'link') {
    throw invalidManifest(id, 'entries[].kind 必须是 file、dir 或 link');
  }
  if (record.linkTarget !== undefined && typeof record.linkTarget !== 'string') {
    throw invalidManifest(id, 'entries[].linkTarget 必须是字符串');
  }
  if (record.linkType !== undefined && record.linkType !== 'junction' && record.linkType !== 'file') {
    throw invalidManifest(id, 'entries[].linkType 必须是 junction 或 file');
  }
  return {
    originalPath: record.originalPath,
    storedPath: record.storedPath as string | null,
    kind: record.kind,
    ...(record.linkTarget === undefined ? {} : { linkTarget: record.linkTarget }),
    ...(record.linkType === undefined ? {} : { linkType: record.linkType }),
  };
}

function parseManifest(text: string, id: string): SnapshotManifest {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw invalidManifest(id, '不是合法 JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidManifest(id, '顶层必须是对象');
  const record = data as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id === '') throw invalidManifest(id, 'id 必须是字符串');
  if (typeof record.operation !== 'string') throw invalidManifest(id, 'operation 必须是字符串');
  if (!Array.isArray(record.entries)) throw invalidManifest(id, 'entries 必须是数组');
  const entries = record.entries.map((entry) => parseEntry(entry, id));
  if (!Array.isArray(record.created) || record.created.some((path) => typeof path !== 'string')) {
    throw invalidManifest(id, 'created 必须是字符串数组');
  }
  return {
    id: record.id,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    operation: record.operation,
    entries,
    created: record.created as string[],
    ...(record.writeInPlace === true ? { writeInPlace: true } : {}),
  };
}

export function listSnapshots(root: string): SnapshotManifest[] {
  if (!existsSync(root)) return [];
  const manifests: SnapshotManifest[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(root, entry.name, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    try {
      manifests.push(parseManifest(readFileSync(manifestPath, 'utf8'), entry.name));
    } catch {
      // A corrupt or malformed snapshot is skipped rather than breaking the whole list.
    }
  }
  return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type RestoreResult = RestoreReport & { snapshotId: string };

function assertRestorable(manifest: SnapshotManifest, allowedRoots: string[]): void {
  if (allowedRoots.length === 0) throw new AppError(400, '没有允许还原的根目录');
  const roots = allowedRoots.map((root) => resolve(root));
  const check = (path: string, field: string): void => {
    const absolute = resolve(path);
    if (!roots.some((root) => isWithin(absolute, root))) {
      throw new AppError(400, `快照 ${manifest.id} 的 ${field} 越界：${path}`);
    }
  };
  for (const entry of manifest.entries) check(entry.originalPath, 'entries[].originalPath');
  for (const path of manifest.created) check(path, 'created[]');
}

/**
 * Puts every backed-up item back and removes what the operation created.
 * `allowedRoots` lists the only places a manifest may touch; anything else is rejected.
 */
export function restoreSnapshot(root: string, id: string, allowedRoots: string[]): RestoreResult {
  if (typeof id !== 'string' || !ID_PATTERN.test(id) || id.includes(ID_DOTS)) {
    throw new AppError(400, `非法的快照 id：${id}`);
  }
  const rootDir = resolve(root);
  const snapshotDir = resolve(rootDir, id);
  if (!isWithin(snapshotDir, rootDir) || snapshotDir === rootDir) {
    throw new AppError(400, `快照路径越界：${id}`);
  }

  const manifestPath = join(snapshotDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new AppError(404, `snapshot not found: ${id}`);
  const manifest = parseManifest(readFileSync(manifestPath, 'utf8'), id);
  assertRestorable(manifest, allowedRoots);

  // Snapshot first, so this restore can itself be undone with the returned id. Paths that are
  // absent now will be created by the restore, so the undo snapshot registers them as created.
  const touched = [...new Set([...manifest.entries.map((entry) => entry.originalPath), ...manifest.created])];
  const undoCreated = touched.filter((path) => lstatOrNull(path) === null);
  const undo = createSnapshot(root, `restore ${manifest.id}`, touched, undoCreated, new Date(), { writeInPlace: true });

  const report: RestoreReport = { restored: [], removed: [], missing: [] };

  for (const entry of manifest.entries) {
    if (
      manifest.writeInPlace &&
      entry.kind === 'file' &&
      entry.storedPath &&
      existsSync(entry.storedPath) &&
      lstatOrNull(entry.originalPath)?.isFile()
    ) {
      // copyFileSync truncates and writes the existing inode, keeping hard links intact.
      copyFileSync(entry.storedPath, entry.originalPath);
      report.restored.push(entry.originalPath);
      continue;
    }

    if (entry.kind === 'link') {
      if (!entry.linkTarget) {
        // Nothing to recreate; leave the live entry alone rather than deleting it.
        report.missing.push(entry.originalPath);
        continue;
      }
      removePath(entry.originalPath);
      try {
        symlinkSync(entry.linkTarget, entry.originalPath, entry.linkType === 'file' ? 'file' : 'junction');
        report.restored.push(entry.originalPath);
      } catch {
        // e.g. a link whose raw target cannot be recreated; keep going with the rest.
        report.missing.push(entry.originalPath);
      }
      continue;
    }

    if (!entry.storedPath || !existsSync(entry.storedPath)) {
      // The backup is gone: never delete live content we cannot put back.
      report.missing.push(entry.originalPath);
      continue;
    }
    removePath(entry.originalPath);
    cpSync(entry.storedPath, entry.originalPath, { recursive: true });
    report.restored.push(entry.originalPath);
  }

  for (const path of manifest.created) {
    if (removePath(path)) report.removed.push(path);
  }

  return { ...report, snapshotId: undo.id };
}

function removePath(path: string): boolean {
  const stat = lstatOrNull(path);
  if (!stat) return false;
  // Windows leaves nothing behind for rmSync on a valid junction, but a dangling one cannot be
  // recreated right after rmSync (EEXIST); unlinking the link itself is the reliable path.
  if (stat.isSymbolicLink()) unlinkSync(path);
  else rmSync(path, { recursive: true, force: true });
  return true;
}
