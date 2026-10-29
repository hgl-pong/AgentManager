import { randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, join } from 'node:path';

import type { RestoreReport, SnapshotEntry, SnapshotManifest } from '../shared/types.ts';

export type { RestoreReport, SnapshotEntry, SnapshotManifest } from '../shared/types.ts';

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function newId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

/** Backs up every existing path before an operation. Links are recorded, not copied. */
export function createSnapshot(
  root: string,
  operation: string,
  paths: string[],
  created: string[] = [],
  now = new Date(),
): SnapshotManifest {
  const id = newId(now);
  const itemsDir = join(root, id, 'items');
  mkdirSync(itemsDir, { recursive: true });

  const entries: SnapshotEntry[] = [];
  paths.forEach((originalPath, index) => {
    const stat = lstatOrNull(originalPath);
    if (!stat) return;

    if (stat.isSymbolicLink()) {
      let linkTarget: string | undefined;
      try {
        linkTarget = realpathSync(originalPath);
      } catch {
        // A dangling link has no resolvable target; restore reports it as missing.
      }
      entries.push({ originalPath, storedPath: null, kind: 'link', linkTarget, linkType: 'junction' });
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
  };
  writeFileSync(join(root, id, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function listSnapshots(root: string): SnapshotManifest[] {
  if (!existsSync(root)) return [];
  const manifests: SnapshotManifest[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(root, entry.name, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    try {
      manifests.push(JSON.parse(readFileSync(manifestPath, 'utf8')) as SnapshotManifest);
    } catch {
      // A corrupt snapshot is skipped rather than breaking the whole list.
    }
  }
  return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Puts every backed-up item back and removes what the operation created. */
export function restoreSnapshot(root: string, id: string): RestoreReport {
  const manifestPath = join(root, id, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`snapshot not found: ${id}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SnapshotManifest;

  const report: RestoreReport = { restored: [], removed: [], missing: [] };

  for (const entry of manifest.entries) {
    removePath(entry.originalPath);

    if (entry.kind === 'link') {
      if (!entry.linkTarget) {
        report.missing.push(entry.originalPath);
        continue;
      }
      symlinkSync(entry.linkTarget, entry.originalPath, entry.linkType === 'junction' ? 'junction' : 'file');
      report.restored.push(entry.originalPath);
      continue;
    }

    if (!entry.storedPath || !existsSync(entry.storedPath)) {
      report.missing.push(entry.originalPath);
      continue;
    }
    cpSync(entry.storedPath, entry.originalPath, { recursive: true });
    report.restored.push(entry.originalPath);
  }

  for (const path of manifest.created) {
    if (removePath(path)) report.removed.push(path);
  }

  return report;
}

function removePath(path: string): boolean {
  if (!lstatOrNull(path)) return false;
  // recursive handles both junction removal and plain directories without following links.
  rmSync(path, { recursive: true, force: true });
  return true;
}
