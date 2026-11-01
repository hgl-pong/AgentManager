import { randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { AppError } from '../shared/types.ts';
import type {
  CacheActionRequest,
  CacheActionResponse,
  CacheRecycleEntry,
  CacheRecycleItem,
  CacheRecycleReport,
  CacheReport,
  CacheRisk,
  CacheTargetKind,
  CacheTargetReport,
  CacheTargetSpec,
} from '../shared/types.ts';
import { isInside } from './scan.ts';

export type { CacheReport, CacheTargetReport, CacheTargetSpec } from '../shared/types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A recycle id is also a directory name, so it may never traverse the recycle root. */
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Thresholds the UI offers; every target reports how much of its content is older than each. */
export const CACHE_AGE_BUCKETS = [1, 7, 30, 90] as const;

/**
 * Live configuration must never end up in a cache target. A match here is a bug in the target list
 * (or a glob that grew too wide), so the target reports an error instead of deleting the file.
 */
const PROTECTED_NAMES = new Set([
  'settings.json',
  'config.toml',
  'claude.md',
  'agents.md',
  'mcp.json',
  'hooks.json',
  'auth.json',
  'mcp-auth.json',
  'credentials.json',
  '.credentials.json',
  'models.json',
  'keybindings.json',
  'servers.json',
  'version.json',
  'installation_id',
]);

interface TargetInput {
  id: string;
  agent: string;
  agentLabel: string;
  label: string;
  path: string;
  kind: CacheTargetKind;
  risk: CacheRisk;
  note?: string;
}

function makeTarget(input: TargetInput): CacheTargetSpec {
  // A glob is not a path, so the open button points at the directory the pattern lives in.
  return { ...input, openPath: input.path.includes('*') ? dirname(input.path) : input.path };
}

/**
 * Every place the three agents are known to grow over time. The client only ever sends ids, so
 * this list — not the request body — decides which paths may be touched.
 */
export function cacheTargets(home: string): CacheTargetSpec[] {
  const claude = join(home, '.claude');
  const codex = join(home, '.codex');
  const pi = join(home, '.pi', 'agent');
  const claudeLabel = 'Claude Code';
  const codexLabel = 'Codex';
  const piLabel = 'pi';

  return [
    makeTarget({
      id: 'claude.projects',
      agent: 'claude',
      agentLabel: claudeLabel,
      label: '会话记录',
      path: join(claude, 'projects'),
      kind: 'dir',
      risk: 'history',
      note: '每个会话的完整对话（*.jsonl）。清理后 claude --resume 找不到这些会话。',
    }),
    makeTarget({
      id: 'claude.history',
      agent: 'claude',
      agentLabel: claudeLabel,
      label: '提示词历史',
      path: join(claude, 'history.jsonl'),
      kind: 'file',
      risk: 'history',
      note: '提交过的提示词；清理后 ↑ 键的历史记录消失。',
    }),
    makeTarget({
      id: 'claude.file-history',
      agent: 'claude',
      agentLabel: claudeLabel,
      label: '文件改动历史',
      path: join(claude, 'file-history'),
      kind: 'dir',
      risk: 'cache',
      note: '编辑文件前的副本，用于撤销；清理后无法再回到更早的版本。',
    }),
    makeTarget({
      id: 'claude.shell-snapshots',
      agent: 'claude',
      agentLabel: claudeLabel,
      label: 'Shell 快照',
      path: join(claude, 'shell-snapshots'),
      kind: 'dir',
      risk: 'cache',
    }),
    makeTarget({
      id: 'claude.cache',
      agent: 'claude',
      agentLabel: claudeLabel,
      label: '缓存目录',
      path: join(claude, 'cache'),
      kind: 'dir',
      risk: 'cache',
    }),
    makeTarget({
      id: 'claude.debug',
      agent: 'claude',
      agentLabel: claudeLabel,
      label: '调试日志',
      path: join(claude, 'debug'),
      kind: 'dir',
      risk: 'cache',
    }),
    makeTarget({
      id: 'claude.image-cache',
      agent: 'claude',
      agentLabel: claudeLabel,
      label: '图片缓存',
      path: join(claude, 'image-cache'),
      kind: 'dir',
      risk: 'cache',
    }),
    makeTarget({
      id: 'claude.paste-cache',
      agent: 'claude',
      agentLabel: claudeLabel,
      label: '粘贴缓存',
      path: join(claude, 'paste-cache'),
      kind: 'dir',
      risk: 'cache',
    }),
    makeTarget({
      id: 'claude.session-env',
      agent: 'claude',
      agentLabel: claudeLabel,
      label: '会话环境',
      path: join(claude, 'session-env'),
      kind: 'dir',
      risk: 'cache',
    }),
    makeTarget({
      id: 'claude.telemetry',
      agent: 'claude',
      agentLabel: claudeLabel,
      label: '遥测',
      path: join(claude, 'telemetry'),
      kind: 'dir',
      risk: 'cache',
    }),
    makeTarget({
      id: 'claude.plans',
      agent: 'claude',
      agentLabel: claudeLabel,
      label: '计划文档',
      path: join(claude, 'plans'),
      kind: 'dir',
      risk: 'cache',
      note: 'plan 模式生成的计划文件。',
    }),
    makeTarget({
      id: 'claude.sessions',
      agent: 'claude',
      agentLabel: claudeLabel,
      label: '会话索引',
      path: join(claude, 'sessions'),
      kind: 'dir',
      risk: 'cache',
    }),
    makeTarget({
      id: 'claude.backups',
      agent: 'claude',
      agentLabel: claudeLabel,
      label: '配置备份目录',
      path: join(claude, 'backups'),
      kind: 'dir',
      risk: 'cache',
    }),
    makeTarget({
      id: 'claude.backup-files',
      agent: 'claude',
      agentLabel: claudeLabel,
      label: '配置备份文件',
      path: join(claude, '*.bak*'),
      kind: 'glob',
      risk: 'cache',
      note: 'agent 自己写的 settings.json.bak-* 副本。',
    }),
    makeTarget({
      id: 'codex.sessions',
      agent: 'codex',
      agentLabel: codexLabel,
      label: '会话记录',
      path: join(codex, 'sessions'),
      kind: 'dir',
      risk: 'history',
      note: 'rollout 记录（*.jsonl）。清理后无法回看这些会话。',
    }),
    makeTarget({
      id: 'codex.history',
      agent: 'codex',
      agentLabel: codexLabel,
      label: '提示词历史',
      path: join(codex, 'history.jsonl'),
      kind: 'file',
      risk: 'history',
      note: '提交过的提示词；清理后 ↑ 键的历史记录消失。',
    }),
    makeTarget({
      id: 'codex.logs',
      agent: 'codex',
      agentLabel: codexLabel,
      label: '运行日志数据库',
      path: join(codex, 'logs_*.sqlite*'),
      kind: 'glob',
      risk: 'cache',
      note: 'logs_*.sqlite 及其 -wal/-shm 作为一个整体处理。',
    }),
    makeTarget({
      id: 'codex.tmp',
      agent: 'codex',
      agentLabel: codexLabel,
      label: '临时目录 .tmp',
      path: join(codex, '.tmp'),
      kind: 'dir',
      risk: 'cache',
      note: '插件市场等下载的临时内容。',
    }),
    makeTarget({
      id: 'codex.tmp-legacy',
      agent: 'codex',
      agentLabel: codexLabel,
      label: '临时目录 tmp',
      path: join(codex, 'tmp'),
      kind: 'dir',
      risk: 'cache',
    }),
    makeTarget({
      id: 'codex.sandbox',
      agent: 'codex',
      agentLabel: codexLabel,
      label: '沙箱临时目录',
      path: join(codex, '.sandbox'),
      kind: 'dir',
      risk: 'cache',
    }),
    makeTarget({
      id: 'codex.backup-files',
      agent: 'codex',
      agentLabel: codexLabel,
      label: '配置备份文件',
      path: join(codex, '*.bak*'),
      kind: 'glob',
      risk: 'cache',
      note: 'config.toml.bak-* 等副本。',
    }),
    makeTarget({
      id: 'pi.sessions',
      agent: 'pi',
      agentLabel: piLabel,
      label: '会话记录',
      path: join(pi, 'sessions'),
      kind: 'dir',
      risk: 'history',
      note: 'pi 的会话 jsonl；清理后 pi --resume 看不到这些会话。',
    }),
    makeTarget({
      id: 'pi.models-store',
      agent: 'pi',
      agentLabel: piLabel,
      label: '模型清单缓存',
      path: join(pi, 'models-store.json'),
      kind: 'file',
      risk: 'cache',
      note: '从网关缓存的模型目录；pi 会重新拉取，离线时短暂没有模型列表。',
    }),
    makeTarget({
      id: 'pi.backup-files',
      agent: 'pi',
      agentLabel: piLabel,
      label: '配置备份文件',
      path: join(pi, '*.bak*'),
      kind: 'glob',
      risk: 'cache',
      note: 'settings.json.bak-* / models.json.bak-* 副本。',
    }),
  ];
}

// ---------------------------------------------------------------- measurement

/** Size and age of one file or one tree; symlinks are neither counted nor followed. */
interface Measured {
  kind: 'file' | 'dir';
  bytes: number;
  files: number;
  oldest?: number;
  newest?: number;
}

interface Candidate {
  path: string;
  kind: 'file' | 'dir';
  bytes: number;
  files: number;
}

function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function listDir(dir: string): Dirent[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

function noteAge(current: Measured, mtimeMs: number): void {
  current.oldest = current.oldest === undefined ? mtimeMs : Math.min(current.oldest, mtimeMs);
  current.newest = current.newest === undefined ? mtimeMs : Math.max(current.newest, mtimeMs);
}

/**
 * Walks a tree without following links: a link is skipped, so a link loop cannot hang the scan and
 * nothing outside the target is ever measured — or later moved.
 */
function walkFiles(root: string, onFile: (path: string, stat: Stats) => void): Measured {
  const totals: Measured = { kind: 'dir', bytes: 0, files: 0 };
  const stack: string[] = [root];
  for (;;) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const child of listDir(current) ?? []) {
      if (child.isSymbolicLink()) continue;
      const path = join(current, child.name);
      if (child.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!child.isFile()) continue;
      // The dirent can be stale, so the numbers come from a fresh lstat.
      const stat = statOrNull(path);
      if (!stat || !stat.isFile()) continue;
      totals.bytes += stat.size;
      totals.files += 1;
      noteAge(totals, stat.mtimeMs);
      onFile(path, stat);
    }
  }
  return totals;
}

/**
 * Measures `path`; a file that is gone or newer than the cutoff (null = no cutoff) yields null.
 * A directory is always measured whole — partial cleans decide per file, not by the folder mtime.
 */
function measurePath(path: string, cutoff: number | null, onFile?: (mtimeMs: number, size: number) => void): Measured | null {
  const stat = statOrNull(path);
  if (!stat) return null;

  if (stat.isFile()) {
    if (cutoff !== null && stat.mtimeMs >= cutoff) return null;
    const measured: Measured = {
      kind: 'file',
      bytes: stat.size,
      files: 1,
      oldest: stat.mtimeMs,
      newest: stat.mtimeMs,
    };
    onFile?.(stat.mtimeMs, stat.size);
    return measured;
  }
  if (!stat.isDirectory()) return null;
  return walkFiles(path, (_path, file) => onFile?.(file.mtimeMs, file.size));
}

// ---------------------------------------------------------------- targets

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function patternToRegExp(pattern: string): RegExp {
  const body = pattern.split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${body}$`, process.platform === 'win32' ? 'i' : '');
}

/** Names in `dir` matching the simple `*` pattern; protected configuration is filtered out. */
function matchGlob(dir: string, pattern: string): string[] {
  const matcher = patternToRegExp(pattern);
  return (listDir(dir) ?? [])
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => matcher.test(name) && !PROTECTED_NAMES.has(name.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * A sqlite database is only meaningful with its -wal/-shm files, so they are cleaned as one unit:
 * a name that looks like a sidecar belongs to the same group as its base file.
 */
function groupKey(name: string): string {
  const match = /^(.*\.sqlite3?)(?:-wal|-shm|-journal)?$/i.exec(name);
  return (match?.[1] ?? name).toLowerCase();
}

function isoOrUndefined(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

function scanTarget(spec: CacheTargetSpec, now: number): CacheTargetReport {
  const report: CacheTargetReport = {
    ...spec,
    exists: false,
    bytes: 0,
    files: 0,
    buckets: CACHE_AGE_BUCKETS.map((days) => ({ days, bytes: 0, files: 0 })),
  };

  const oldest: { value?: number } = {};
  const newest: { value?: number } = {};
  const addFile = (mtimeMs: number, size: number): void => {
    for (const bucket of report.buckets) {
      if (mtimeMs < now - bucket.days * DAY_MS) {
        bucket.bytes += size;
        bucket.files += 1;
      }
    }
  };
  const add = (measured: Measured): void => {
    report.bytes += measured.bytes;
    report.files += measured.files;
    if (measured.oldest !== undefined) {
      oldest.value = oldest.value === undefined ? measured.oldest : Math.min(oldest.value, measured.oldest);
    }
    if (measured.newest !== undefined) {
      newest.value = newest.value === undefined ? measured.newest : Math.max(newest.value, measured.newest);
    }
  };

  try {
    if (spec.kind === 'file') {
      if (PROTECTED_NAMES.has(basename(spec.path).toLowerCase())) {
        throw new Error(`缓存目标不能是配置文件：${spec.path}`);
      }
      const stat = statOrNull(spec.path);
      if (!stat || !stat.isFile()) return report;
      report.exists = true;
      add({ kind: 'file', bytes: stat.size, files: 1, oldest: stat.mtimeMs, newest: stat.mtimeMs });
      addFile(stat.mtimeMs, stat.size);
    } else if (spec.kind === 'glob') {
      const dir = dirname(spec.path);
      for (const name of matchGlob(dir, basename(spec.path))) {
        const measured = measurePath(join(dir, name), null, addFile);
        if (!measured) continue;
        report.exists = true;
        add(measured);
      }
    } else {
      const stat = statOrNull(spec.path);
      if (!stat || !stat.isDirectory()) return report;
      report.exists = true;
      add(measurePath(spec.path, null, addFile) ?? { kind: 'dir', bytes: 0, files: 0 });
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }

  const oldestIso = isoOrUndefined(oldest.value);
  const newestIso = isoOrUndefined(newest.value);
  if (oldestIso) report.oldest = oldestIso;
  if (newestIso) report.newest = newestIso;
  return report;
}

/** Read-only: measures every target and lists the recycle bin. */
export interface CacheInput {
  targets: CacheTargetSpec[];
  recycleRoot: string;
  /** Injectable clock for tests. */
  now?: Date;
}

export function scanCache(input: CacheInput): CacheReport {
  const started = performance.now();
  const now = input.now ?? new Date();
  return {
    targets: input.targets.map((spec) => scanTarget(spec, now.getTime())),
    recycle: listRecycle(input.recycleRoot),
    scannedAt: now.toISOString(),
    durationMs: Math.round(performance.now() - started),
  };
}

// ---------------------------------------------------------------- recycle bin

function sumFiles(entries: CacheRecycleEntry[]): number {
  return entries.reduce((total, entry) => total + entry.files, 0);
}

function sumBytes(entries: CacheRecycleEntry[]): number {
  return entries.reduce((total, entry) => total + entry.bytes, 0);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index] ?? 'TB'}`;
}

function writeManifest(recycleRoot: string, item: CacheRecycleItem): void {
  const itemDir = join(recycleRoot, item.id);
  mkdirSync(itemDir, { recursive: true });
  writeFileSync(join(itemDir, 'manifest.json'), `${JSON.stringify(item, null, 2)}\n`);
}

function newItemId(root: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = `${stamp}-${randomBytes(4).toString('hex')}`;
    if (!existsSync(join(root, id))) return id;
  }
  throw new Error(`无法生成不重复的回收站 id：${stamp}`);
}

/**
 * Renames when the recycle bin shares a volume with the agent directory — the usual case, and
 * instant even for gigabytes. Only a cross-volume move falls back to copy + delete.
 */
function movePath(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  cpSync(from, to, { recursive: true });
  rmSync(from, { recursive: true, force: true });
}

function invalidItem(id: string, detail: string): AppError {
  return new AppError(400, `回收站条目 ${id} 的 manifest 无效：${detail}`);
}

function parseEntry(value: unknown, id: string): CacheRecycleEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidItem(id, 'entries 项不是对象');
  const record = value as Record<string, unknown>;
  if (typeof record.originalPath !== 'string' || record.originalPath === '') {
    throw invalidItem(id, 'entries[].originalPath 必须是字符串');
  }
  if (typeof record.storedPath !== 'string' || record.storedPath === '') {
    throw invalidItem(id, 'entries[].storedPath 必须是字符串');
  }
  if (record.kind !== 'file' && record.kind !== 'dir') throw invalidItem(id, 'entries[].kind 必须是 file 或 dir');
  const bytes = typeof record.bytes === 'number' && record.bytes >= 0 ? record.bytes : 0;
  const files = typeof record.files === 'number' && record.files >= 0 ? record.files : 0;
  return { originalPath: record.originalPath, storedPath: record.storedPath, kind: record.kind, bytes, files };
}

function parseItem(text: string, dirName: string): CacheRecycleItem {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw invalidItem(dirName, '不是合法 JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidItem(dirName, '顶层必须是对象');
  const record = data as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id === '') throw invalidItem(dirName, 'id 必须是字符串');
  if (typeof record.operation !== 'string') throw invalidItem(dirName, 'operation 必须是字符串');
  if (!Array.isArray(record.entries)) throw invalidItem(dirName, 'entries 必须是数组');
  if (!Array.isArray(record.targetIds) || record.targetIds.some((value) => typeof value !== 'string')) {
    throw invalidItem(dirName, 'targetIds 必须是字符串数组');
  }
  const entries = record.entries.map((entry) => parseEntry(entry, dirName));
  return {
    // The directory name is the id, exactly like snapshots: a manifest in dir A may never
    // address dir B, no matter what it claims in its own `id` field.
    id: dirName,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    operation: record.operation,
    targetIds: record.targetIds as string[],
    entries,
    bytes: sumBytes(entries),
    files: sumFiles(entries),
  };
}

function listRecycleItems(root: string): CacheRecycleItem[] {
  const items: CacheRecycleItem[] = [];
  for (const entry of listDir(root) ?? []) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      items.push(parseItem(readFileSync(join(root, entry.name, 'manifest.json'), 'utf8'), entry.name));
    } catch {
      // A corrupt or half-written item is skipped rather than breaking the whole list.
    }
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function listRecycle(root: string): CacheRecycleReport {
  const items = listRecycleItems(root);
  const entries = items.flatMap((item) => item.entries);
  return { path: root, items, bytes: sumBytes(entries), files: sumFiles(entries) };
}

function readRecycleItem(root: string, id: string): CacheRecycleItem {
  if (typeof id !== 'string' || !ID_PATTERN.test(id) || id.includes('..')) {
    throw new AppError(400, `非法的回收站 id：${id}`);
  }
  const rootDir = resolve(root);
  const itemDir = resolve(rootDir, id);
  if (!isInside(itemDir, rootDir)) throw new AppError(400, `回收站路径越界：${id}`);
  const manifestPath = join(itemDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new AppError(404, `回收站里没有 ${id}`);
  return parseItem(readFileSync(manifestPath, 'utf8'), id);
}

// ---------------------------------------------------------------- clean

/** The directory a manifest entry may live in: the target itself, or a glob's parent. */
function entryRoot(spec: CacheTargetSpec): string {
  return spec.kind === 'dir' ? spec.path : dirname(spec.path);
}

function normalizeForCompare(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? trimmed.toLowerCase().replaceAll('/', '\\') : trimmed;
}

/** Containment that also accepts the root itself, unlike `isInside`. */
function isWithin(child: string, root: string): boolean {
  return normalizeForCompare(child) === normalizeForCompare(root) || isInside(child, root);
}

/**
 * Candidates a clean would move. `cutoff === null` means the whole target; otherwise only files
 * older than the cutoff inside a directory target.
 */
function candidatesFor(spec: CacheTargetSpec, cutoff: number | null): Candidate[] {
  if (spec.kind === 'file') {
    if (PROTECTED_NAMES.has(basename(spec.path).toLowerCase())) {
      throw new AppError(500, `缓存目标不能是配置文件：${spec.path}`);
    }
    const measured = measurePath(spec.path, cutoff);
    return measured && measured.kind === 'file' ? [{ path: spec.path, ...measured }] : [];
  }

  if (spec.kind === 'glob') {
    const dir = dirname(spec.path);
    const groups = new Map<string, string[]>();
    for (const name of matchGlob(dir, basename(spec.path))) {
      const key = groupKey(name);
      const group = groups.get(key);
      if (group) group.push(name);
      else groups.set(key, [name]);
    }

    const picked: Candidate[] = [];
    for (const names of groups.values()) {
      const measured = names.map((name) => ({ name, measured: measurePath(join(dir, name), cutoff) }));
      // All-or-nothing per group: a fresh -wal next to an old .sqlite means the pair is in use.
      if (measured.some((entry) => entry.measured === null)) continue;
      for (const { name, measured: entry } of measured) {
        if (entry) picked.push({ path: join(dir, name), ...entry });
      }
    }
    return picked;
  }

  const stat = statOrNull(spec.path);
  if (!stat || !stat.isDirectory()) return [];
  // A whole-target clean moves the directory in one step; a partial one moves single files.
  if (cutoff === null) {
    const measured = measurePath(spec.path, null);
    return measured ? [{ path: spec.path, ...measured }] : [];
  }

  const picked: Candidate[] = [];
  walkFiles(spec.path, (path, file) => {
    if (file.mtimeMs < cutoff) picked.push({ path, kind: 'file', bytes: file.size, files: 1 });
  });
  return picked;
}

/** Removes directories that a partial clean left empty, so the tree does not keep dead branches. */
function pruneEmptyDirs(root: string): void {
  const prune = (dir: string): void => {
    for (const child of listDir(dir) ?? []) {
      if (child.isSymbolicLink() || !child.isDirectory()) continue;
      const path = join(dir, child.name);
      prune(path);
      const entries = listDir(path);
      // Only a directory we could read and that is empty may go; an unreadable one keeps its content.
      if (entries !== null && entries.length === 0) rmSync(path, { recursive: true, force: true });
    }
  };
  prune(root);
}

function buildItem(
  id: string,
  now: Date,
  operation: string,
  targetIds: string[],
  entries: CacheRecycleEntry[],
): CacheRecycleItem {
  return {
    id,
    createdAt: now.toISOString(),
    operation,
    targetIds,
    entries,
    bytes: sumBytes(entries),
    files: sumFiles(entries),
  };
}

function moveToRecycle(
  input: CacheInput,
  plan: { spec: CacheTargetSpec; candidates: Candidate[] }[],
  days: number,
  now: Date,
): CacheRecycleItem {
  const id = newItemId(input.recycleRoot, now);
  const itemsDir = join(input.recycleRoot, id, 'items');
  mkdirSync(itemsDir, { recursive: true });

  const labels = plan.map((entry) => entry.spec.label).join('、');
  const operation = `清理缓存 ${days === 0 ? '全部' : `${days} 天前`}（${labels}）`;
  const targetIds = [...new Set(plan.map((entry) => entry.spec.id))];
  const entries: CacheRecycleEntry[] = [];

  try {
    for (const { candidates } of plan) {
      for (const candidate of candidates) {
        const storedPath = join(itemsDir, `${String(entries.length).padStart(3, '0')}-${basename(candidate.path)}`);
        movePath(candidate.path, storedPath);
        entries.push({
          originalPath: candidate.path,
          storedPath,
          kind: candidate.kind,
          bytes: candidate.bytes,
          files: candidate.files,
        });
      }
    }
  } catch (error) {
    // Whatever already moved stays restorable: the manifest records exactly that subset.
    if (entries.length > 0) writeManifest(input.recycleRoot, buildItem(id, now, operation, targetIds, entries));
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError(
      500,
      `清理中断：${entries.length} 项（${formatBytes(sumBytes(entries))}）已移入回收站并可恢复，失败原因：${message}`,
    );
  }

  const item = buildItem(id, now, operation, targetIds, entries);
  writeManifest(input.recycleRoot, item);
  return item;
}

// ---------------------------------------------------------------- actions

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

function specById(targets: CacheTargetSpec[], id: string): CacheTargetSpec {
  const spec = targets.find((candidate) => candidate.id === id);
  if (!spec) throw new AppError(400, `未知的缓存位置：${id}`);
  return spec;
}

function assertRestorable(entry: CacheRecycleEntry, itemDir: string, targets: CacheTargetSpec[]): void {
  if (!isWithin(resolve(entry.storedPath), resolve(itemDir))) {
    throw new AppError(400, `回收站条目越界：${entry.storedPath}`);
  }
  if (!targets.some((spec) => isWithin(resolve(entry.originalPath), resolve(entryRoot(spec))))) {
    throw new AppError(400, `回收站条目的原路径不在任何缓存位置内：${entry.originalPath}`);
  }
}

function restoreItem(
  input: CacheInput,
  item: CacheRecycleItem,
): { files: number; bytes: number; skipped: string[] } {
  const itemDir = join(input.recycleRoot, item.id);
  const remaining: CacheRecycleEntry[] = [];
  const skipped: string[] = [];
  let files = 0;
  let bytes = 0;

  for (const entry of item.entries) {
    assertRestorable(entry, itemDir, input.targets);
    const occupied = statOrNull(entry.originalPath) !== null;
    const backupMissing = statOrNull(entry.storedPath) === null;
    if (occupied || backupMissing) {
      // Never overwrite live content, and never drop a manifest entry whose backup is gone.
      remaining.push(entry);
      skipped.push(entry.originalPath);
      continue;
    }
    try {
      movePath(entry.storedPath, entry.originalPath);
      files += entry.files;
      bytes += entry.bytes;
    } catch {
      // One unwritable path must not turn the rest of the restore into a half-done mess.
      remaining.push(entry);
      skipped.push(entry.originalPath);
    }
  }

  if (remaining.length === 0) {
    rmSync(itemDir, { recursive: true, force: true });
  } else {
    writeManifest(input.recycleRoot, { ...item, entries: remaining, bytes: sumBytes(remaining), files: sumFiles(remaining) });
  }
  return { files, bytes, skipped };
}

/**
 * Cleans cache targets by moving content into the recycle bin. Nothing is ever deleted here: a
 * clean is undoable until the bin itself is purged, which is the only destructive action.
 */
export function runCacheAction(
  input: CacheInput,
  request: CacheActionRequest,
  now = new Date(),
): CacheActionResponse {
  const action = request.action;
  if (action !== 'clean' && action !== 'restore' && action !== 'purge') {
    throw new AppError(400, `未知的缓存动作：${String(action)}`);
  }

  if (action === 'clean') {
    const ids = stringArray(request.ids);
    if (ids.length === 0) throw new AppError(400, '请选择要清理的缓存位置');
    const days = request.olderThanDays === undefined ? 0 : request.olderThanDays;
    if (!Number.isInteger(days) || days < 0 || days > 3650) {
      throw new AppError(400, 'olderThanDays 必须是 0 到 3650 之间的整数');
    }
    const specs = [...new Set(ids)].map((id) => specById(input.targets, id));
    const cutoff = days === 0 ? null : now.getTime() - days * DAY_MS;

    const plan = specs
      .map((spec) => ({ spec, candidates: candidatesFor(spec, cutoff) }))
      .filter((entry) => entry.candidates.length > 0);

    if (plan.length === 0) {
      return { message: '没有符合条件的内容，未改动任何文件。', report: scanCache({ ...input, now }) };
    }

    const item = moveToRecycle(input, plan, days, now);
    for (const { spec } of plan) {
      if (spec.kind === 'dir' && cutoff !== null) pruneEmptyDirs(spec.path);
    }

    const labels = plan.map((entry) => entry.spec.label).join('、');
    const scope = days === 0 ? '全部内容' : `${days} 天前的文件`;
    return {
      message: `${labels}：已把${scope} ${item.files} 个文件（${formatBytes(item.bytes)}）移入回收站，可在本页恢复。`,
      movedBytes: item.bytes,
      movedFiles: item.files,
      recycleId: item.id,
      report: scanCache({ ...input, now }),
    };
  }

  if (action === 'restore') {
    const ids = stringArray(request.recycleIds);
    if (ids.length === 0) throw new AppError(400, '请选择要恢复的回收站项目');
    const items = [...new Set(ids)].map((id) => readRecycleItem(input.recycleRoot, id));

    let files = 0;
    let bytes = 0;
    const skipped: string[] = [];
    for (const item of items) {
      const result = restoreItem(input, item);
      files += result.files;
      bytes += result.bytes;
      skipped.push(...result.skipped);
    }

    const parts = [`已恢复 ${files} 个文件（${formatBytes(bytes)}）到原位置`];
    if (skipped.length > 0) parts.push(`${skipped.length} 项没能恢复，仍留在回收站`);
    return {
      message: `${parts.join('，')}。`,
      ...(files > 0 ? { movedFiles: files, movedBytes: bytes } : {}),
      ...(skipped.length > 0 ? { skipped } : {}),
      report: scanCache({ ...input, now }),
    };
  }

  const ids = stringArray(request.recycleIds);
  const items = ids.length === 0 ? listRecycleItems(input.recycleRoot) : [...new Set(ids)].map((id) => readRecycleItem(input.recycleRoot, id));
  if (items.length === 0) {
    return { message: '回收站是空的，没有需要删除的内容。', report: scanCache({ ...input, now }) };
  }

  const files = sumFiles(items.flatMap((item) => item.entries));
  const bytes = sumBytes(items.flatMap((item) => item.entries));
  for (const item of items) rmSync(join(input.recycleRoot, item.id), { recursive: true, force: true });

  return {
    message: `已彻底删除 ${items.length} 项（${files} 个文件，${formatBytes(bytes)}），无法再恢复。`,
    movedFiles: files,
    movedBytes: bytes,
    report: scanCache({ ...input, now }),
  };
}