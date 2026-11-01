import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { AppError } from '../shared/types.ts';
import type {
  AgentSpec,
  StoreInstallLink,
  StoreInstallReport,
  StoreInstallRequest,
  StoreListing,
  StoreReport,
  StoreSkill,
} from '../shared/types.ts';
import { moveDirectory } from './actions.ts';
import { hasSkillFile, isInside } from './scan.ts';
import { createSnapshot, markSnapshotFailed } from './snapshot.ts';
import { unzip } from './zip.ts';

export type {
  StoreInstallLink,
  StoreInstallReport,
  StoreInstallRequest,
  StoreListing,
  StoreReport,
  StoreSkill,
} from '../shared/types.ts';

/**
 * skillstore.io: one JSON endpoint for the catalog, one manifest per skill, and one ZIP per
 * manifest. Any registry that speaks the same three routes can be swapped in with
 * `AGENT_MANAGER_STORE_URL`.
 */
const DEFAULT_BASE_URL = 'https://skillstore.io';
const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 24;
const FETCH_TIMEOUT_MS = 20_000;
const FETCH_ATTEMPTS = 3;
const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_ENTRIES = 1_000;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Windows refuses these names with or without an extension; a skill directory must not use them. */
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

// ---- reading the catalog ----

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  const text = asString(value);
  if (text === '') return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Maps one catalog row (`/api/skills` and `/api/skills/<slug>` share the shape). */
export function normalizeStoreSkill(raw: unknown): StoreSkill | null {
  const record = asRecord(raw);
  const slug = asString(record.slug);
  if (slug === '') return null;

  const stats = asRecord(record.stats);
  const risk = asString(record.riskLevel);
  const category = asString(record.category);
  const license = asString(record.license);
  const repository = asString(record.repo);
  const version = asString(record.authorVersion);
  const quality = asNumber(record.qualityScore);
  const updatedAt = isoTimestamp(record.updatedAt);
  const hasScripts = asBoolean(record.hasScripts);
  const needsNetwork = asBoolean(record.needsNetwork);

  return {
    id: slug,
    slug,
    owner: asString(record.author) || asString(record.githubUsername) || 'unknown',
    name: asString(record.displayName) || slug,
    summary: asString(record.description) || asString(record.aiDescription),
    ...(category === '' ? {} : { category }),
    ...(risk === 'safe' || risk === 'medium' || risk === 'high' || risk === 'critical' ? { risk } : {}),
    ...(license === '' ? {} : { license }),
    ...(repository === '' ? {} : { repository }),
    ...(quality === 0 ? {} : { quality }),
    ...(hasScripts === undefined ? {} : { hasScripts }),
    ...(needsNetwork === undefined ? {} : { needsNetwork }),
    downloads: asNumber(stats.downloadCount),
    favorites: asNumber(stats.favoriteCount),
    ...(version === '' ? {} : { version }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    inSource: false,
  };
}

/** Same mapping for a whole payload, with duplicates collapsed by slug. */
export function normalizeStoreSkills(payload: unknown): StoreSkill[] {
  const record = asRecord(payload);
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(record.data)
      ? (record.data as unknown[])
      : Array.isArray(record.items)
        ? (record.items as unknown[])
        : [];
  const skills = new Map<string, StoreSkill>();
  for (const entry of list) {
    const skill = normalizeStoreSkill(entry);
    if (skill && !skills.has(skill.id)) skills.set(skill.id, skill);
  }
  return [...skills.values()];
}

/**
 * Puts rows whose name actually contains the query first: the registry searches descriptions
 * too, which otherwise buries "how-to-use-react" under unrelated packages.
 */
export function rankStoreSkills(items: StoreSkill[], query: string): StoreSkill[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return items;
  const score = (skill: StoreSkill): number => {
    const name = skill.name.toLowerCase();
    const slug = skill.slug.toLowerCase();
    if (name === needle) return 4;
    if (name.startsWith(needle)) return 3;
    if (name.includes(needle)) return 2;
    if (slug.includes(needle)) return 1;
    return 0;
  };
  return [...items].sort((a, b) => score(b) - score(a));
}

/** The registry base URL: env override, always http(s), never with a trailing slash. */
export function storeBaseUrl(override?: string): string {
  const raw = (override ?? process.env.AGENT_MANAGER_STORE_URL ?? DEFAULT_BASE_URL).trim();
  const trimmed = raw.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) throw new AppError(400, '技能商店地址必须是 http(s) URL');
  return trimmed;
}

function registryUrl(base: string, path: string, params: Record<string, string | number> = {}): string {
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return `${base}${path}${query === '' ? '' : `?${query}`}`;
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** The registry intermittently answers 5xx for a valid request, so a couple of retries are normal. */
async function fetchWithRetry(url: string, fetchImpl: typeof fetch, accept: string): Promise<Response> {
  let lastError = '';
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await delay(400 * attempt);
    try {
      const response = await fetchImpl(url, {
        headers: { accept },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.ok) return response;
      const body = await response.text().catch(() => '');
      lastError = `HTTP ${response.status}${body === '' ? '' : `：${describeBody(body)}`}`;
      if (response.status < 500) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new AppError(502, `技能商店请求失败（${lastError}）`);
}

function describeBody(body: string): string {
  const text = body.trim();
  if (text.startsWith('{')) {
    try {
      const parsed = asRecord(JSON.parse(text));
      const message = asString(parsed.message) || asString(parsed.error) || asString(parsed.code);
      if (message !== '') return message.slice(0, 200);
    } catch {
      // Fall through to the raw text.
    }
  }
  return text.slice(0, 200);
}

interface StoreCacheEntry {
  key: string;
  at: number;
  items: StoreSkill[];
  total: number;
  totalPages: number;
}

const cache = new Map<string, StoreCacheEntry>();

function cacheGet(key: string): StoreCacheEntry | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > CACHE_TTL_MS * 10) {
    cache.delete(key);
    return undefined;
  }
  return entry;
}

function cacheSet(entry: StoreCacheEntry): void {
  cache.delete(entry.key);
  cache.set(entry.key, entry);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export interface StoreInput {
  query?: string;
  /** 1-based page of the registry result set. */
  page?: number;
  limit?: number;
  refresh?: boolean;
  /** Skill directory names already in the source, so the page can mark them. */
  sourceSkills?: string[];
  sourcePath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  baseUrl?: string;
}

function storeReport(input: {
  items: StoreSkill[];
  total: number;
  totalPages: number;
  page: number;
  limit: number;
  sourceSkills: string[];
  sourcePath: string;
  baseUrl: string;
  query: string;
  listing: StoreListing;
  fetchedAt: string;
  cached: boolean;
  stale?: boolean;
  error?: string;
}): StoreReport {
  const present = new Set(input.sourceSkills);
  return {
    provider: 'skillstore.io',
    endpoint: input.baseUrl,
    query: input.query,
    listing: input.listing,
    page: input.page,
    limit: input.limit,
    totalPages: input.totalPages,
    total: input.total,
    fetchedAt: input.fetchedAt,
    cached: input.cached,
    ...(input.stale === undefined ? {} : { stale: input.stale }),
    ...(input.error === undefined ? {} : { error: input.error }),
    sourcePath: input.sourcePath,
    items: input.items.map((item) => ({
      ...item,
      inSource: present.has(item.name) || present.has(item.slug),
    })),
  };
}

/**
 * Fetches the catalog for a page: the registry's own ordering when the query is empty, its
 * search answer otherwise. Failures come back as a report with `error` (and a stale answer when
 * one is cached) instead of throwing, so the page keeps working through a registry wobble.
 */
export async function getStoreReport(input: StoreInput = {}): Promise<StoreReport> {
  const query = (input.query ?? '').trim().slice(0, 120);
  const limit = Math.min(50, Math.max(1, Math.round(input.limit ?? 12)));
  const page = Math.max(1, Math.round(input.page ?? 1));
  const listing: StoreListing = query === '' ? 'featured' : 'search';
  const sourcePath = input.sourcePath ?? '';
  const fetchedAt = new Date(input.now?.() ?? Date.now()).toISOString();
  const sourceSkills = input.sourceSkills ?? [];

  let base: string;
  try {
    base = storeBaseUrl(input.baseUrl);
  } catch (error) {
    return storeReport({
      items: [],
      total: 0,
      totalPages: 1,
      page,
      limit,
      sourceSkills,
      sourcePath,
      baseUrl: input.baseUrl ?? '',
      query,
      listing,
      fetchedAt,
      cached: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const key = `${base}|${listing}|${query}|${limit}|${page}`;
  if (!input.refresh) {
    const hit = cacheGet(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return storeReport({
        items: hit.items,
        total: hit.total,
        totalPages: hit.totalPages,
        page,
        limit,
        sourceSkills,
        sourcePath,
        baseUrl: base,
        query,
        listing,
        fetchedAt,
        cached: true,
      });
    }
  }

  const url = registryUrl(base, '/api/skills', {
    limit,
    page,
    ...(query === '' ? {} : { q: query }),
  });

  try {
    const response = await fetchWithRetry(url, input.fetchImpl ?? fetch, 'application/json');
    const payload = await response.json();
    const record = asRecord(payload);
    const total = asNumber(record.total);
    const registryPage = asRecord(record.pagination);
    const totalPages =
      asNumber(registryPage.totalPages) || Math.max(1, Math.ceil(total / limit));
    const items = rankStoreSkills(normalizeStoreSkills(payload), query);
    cacheSet({ key, at: Date.now(), items, total, totalPages });
    return storeReport({
      items,
      total,
      totalPages,
      page,
      limit,
      sourceSkills,
      sourcePath,
      baseUrl: base,
      query,
      listing,
      fetchedAt,
      cached: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hit = cacheGet(key);
    if (hit) {
      return storeReport({
        items: hit.items,
        total: hit.total,
        totalPages: hit.totalPages,
        page,
        limit,
        sourceSkills,
        sourcePath,
        baseUrl: base,
        query,
        listing,
        fetchedAt,
        cached: true,
        stale: true,
        error: message,
      });
    }
    return storeReport({
      items: [],
      total: 0,
      totalPages: 1,
      page,
      limit,
      sourceSkills,
      sourcePath,
      baseUrl: base,
      query,
      listing,
      fetchedAt,
      cached: false,
      error: message,
    });
  }
}

/** Test hook: drop the in-memory listing cache. */
export function clearStoreCache(): void {
  cache.clear();
}

// ---- installing a skill ----

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function assertSegment(value: string, label: string, pattern: RegExp): string {
  const trimmed = value.trim();
  if (!pattern.test(trimmed) || trimmed.includes('..')) {
    throw new AppError(400, `非法的 ${label}：${value}`);
  }
  return trimmed;
}

/** Directory name inside the source. It becomes a real path segment, so it is checked strictly. */
function skillName(value: string): string {
  const name = assertSegment(value, 'skill 名', SKILL_NAME_PATTERN);
  if (RESERVED_NAMES.has(name.split('.')[0]?.toLowerCase() ?? '')) {
    throw new AppError(400, `${name} 是 Windows 保留名，请换一个名字`);
  }
  return name;
}

/** Every skill directory in the source, so the page can say "源里已有" without a second request. */
export function listInstalledSkills(source: string): string[] {
  let entries;
  try {
    entries = readdirSync(source, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && hasSkillFile(join(source, entry.name)))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export interface StoreArtifact {
  /** Directory name the registry gives the skill, which is usually its real name. */
  name: string;
  url: string;
  sha256?: string;
}

/** Reads `/api/skills/<slug>/manifest` into the download it points at. */
export function readManifest(payload: unknown, base: string, slug: string): StoreArtifact {
  const record = asRecord(payload);
  const skill = asRecord(record.skill);
  const artifact = asRecord(record.artifact);

  const name = asString(skill.name) || slug;
  const url = asString(artifact.url) || registryUrl(base, `/api/skills/${encodeURIComponent(slug)}/download`);
  if (!/^https?:\/\//i.test(url)) throw new AppError(502, `商店返回的下载地址无效：${url}`);
  const sha256 = asString(artifact.sha256).toLowerCase();

  return { name, url, ...(sha256 === '' ? {} : { sha256 }) };
}

async function fetchManifest(options: {
  baseUrl: string;
  slug: string;
  fetchImpl: typeof fetch;
}): Promise<StoreArtifact> {
  const url = registryUrl(options.baseUrl, `/api/skills/${encodeURIComponent(options.slug)}/manifest`);
  try {
    const response = await fetchWithRetry(url, options.fetchImpl, 'application/json');
    return readManifest(await response.json(), options.baseUrl, options.slug);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError(502, `读取 ${options.slug} 的 manifest 失败：${message}`);
  }
}

async function downloadArtifact(options: {
  artifact: StoreArtifact;
  slug: string;
  fetchImpl: typeof fetch;
}): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetchWithRetry(
      options.artifact.url,
      options.fetchImpl,
      'application/zip, application/octet-stream',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError(502, `下载 ${options.slug} 失败：${message}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_ZIP_BYTES) {
    throw new AppError(400, `${options.slug} 超过 ${MAX_ZIP_BYTES / 1024 / 1024}MB 上限`);
  }
  // A proxy or rate limiter can answer 200 with an HTML page; only a local header counts as a ZIP.
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new AppError(502, `商店没有返回 ZIP 包（${options.slug}）`);
  }
  if (options.artifact.sha256 !== undefined) {
    const digest = createHash('sha256').update(buffer).digest('hex');
    if (digest !== options.artifact.sha256) {
      throw new AppError(502, `${options.slug} 的校验值不一致（期望 ${options.artifact.sha256.slice(0, 12)}…，实得 ${digest.slice(0, 12)}…）`);
    }
  }
  return buffer;
}

/**
 * Registries wrap the skill in a folder sometimes and ship it at the root otherwise. Dropping the
 * shared top folder makes both layouts land as `<source>/<skill>/SKILL.md`.
 */
export function stripCommonDirectory(names: string[]): string[] {
  const normalized = names.map((name) => name.replaceAll('\\', '/').replace(/^\.\//, ''));
  const segments = normalized.map((name) => name.split('/'));
  const first = segments[0]?.[0];
  if (first === undefined || first === '' || segments.some((parts) => parts.length < 2 || parts[0] !== first)) {
    return normalized;
  }
  return segments.map((parts) => parts.slice(1).join('/'));
}

/** Writes the archive under `root`, refusing absolute paths, `..` and anything outside `root`. */
export function extractZipEntries(
  entries: { name: string; data: Buffer }[],
  root: string,
): { files: number; bytes: number } {
  const directory = resolve(root);
  mkdirSync(directory, { recursive: true });
  const stripped = stripCommonDirectory(entries.map((entry) => entry.name));

  let files = 0;
  let bytes = 0;
  entries.forEach((entry, index) => {
    const relativePath = stripped[index] ?? '';
    if (relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath)) {
      throw new AppError(400, `压缩包里含绝对路径：${entry.name}`);
    }
    const segments = relativePath.split('/').filter((segment) => segment !== '' && segment !== '.');
    if (segments.length === 0 || segments.includes('..')) {
      throw new AppError(400, `压缩包里含越界路径：${entry.name}`);
    }
    // macOS adds a resource-fork folder nobody needs.
    if (segments[0] === '__MACOSX') return;

    const destination = resolve(directory, ...segments);
    if (!isInside(destination, directory)) {
      throw new AppError(400, `压缩包里含越界路径：${entry.name}`);
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, entry.data, { mode: 0o644 });
    files += 1;
    bytes += entry.data.length;
  });

  return { files, bytes };
}

export interface StoreInstallInput {
  source: string;
  snapshotRoot: string;
  /** Scratch space for the download; outside the source so a failure leaves no skill behind. */
  tempRoot: string;
  agents: AgentSpec[];
  request: StoreInstallRequest;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
}

/**
 * Downloads a skill into the single source, then optionally links it into agents.
 * One snapshot covers the new directory and every link, so a restore removes exactly what this
 * operation created.
 */
export async function installStoreSkill(input: StoreInstallInput): Promise<StoreInstallReport> {
  const slug = assertSegment(String(input.request.slug ?? ''), 'slug', SLUG_PATTERN);
  const owner = String(input.request.owner ?? '').trim();
  const base = storeBaseUrl(input.baseUrl);

  // Resolve the agents first: a typo in the request should fail before any download.
  const requested = [...new Set((input.request.agents ?? []).map(String))];
  const resolved: AgentSpec[] = [];
  for (const key of requested) {
    const agent = input.agents.find((candidate) => candidate.key === key);
    if (!agent) throw new AppError(400, `未知的 agent：${key}`);
    resolved.push(agent);
  }

  const artifact = await fetchManifest({ baseUrl: base, slug, fetchImpl: input.fetchImpl ?? fetch });
  const name = skillName(String(input.request.name ?? '').trim() || artifact.name);

  const destination = join(input.source, name);
  if (lstatOrNull(destination) || existsSync(destination)) {
    throw new AppError(409, `源里已经有 ${name}，先移除它（或换个名字）再安装`);
  }

  // An existing entry is never replaced: that decision belongs to the skills page.
  const targets = resolved.map((agent) => ({ agent, skip: lstatOrNull(join(agent.root, name)) !== null }));

  const buffer = await downloadArtifact({
    artifact,
    slug,
    fetchImpl: input.fetchImpl ?? fetch,
  });
  const entries = unzip(buffer, {
    maxEntries: MAX_ENTRIES,
    maxFileBytes: MAX_FILE_BYTES,
    maxTotalBytes: MAX_TOTAL_BYTES,
  });
  if (entries.length === 0) throw new AppError(400, `压缩包是空的（${slug}）`);

  mkdirSync(input.tempRoot, { recursive: true });
  const staging = mkdtempSync(join(input.tempRoot, 'store-'));
  try {
    const written = extractZipEntries(entries, staging);
    if (!hasSkillFile(staging)) {
      throw new AppError(400, `压缩包里没有 SKILL.md，不是可安装的 skill（${slug}）`);
    }

    const snapshot = createSnapshot(
      input.snapshotRoot,
      `install ${owner === '' ? slug : `${owner}/${name}`}`,
      [],
      [destination, ...targets.filter((target) => !target.skip).map((target) => join(target.agent.root, name))],
      new Date(input.now?.() ?? Date.now()),
    );

    try {
      mkdirSync(input.source, { recursive: true });
      moveDirectory(staging, destination);
    } catch (error) {
      markSnapshotFailed(input.snapshotRoot, snapshot.id);
      throw error;
    }

    const links: StoreInstallLink[] = [];
    const warnings: string[] = [];

    for (const { agent, skip } of targets) {
      const linkPath = join(agent.root, name);
      if (skip) {
        links.push({
          agent: agent.key,
          label: agent.label,
          state: 'skipped',
          message: `${agent.label} 里已经有同名条目，未改动`,
        });
        continue;
      }
      try {
        mkdirSync(agent.root, { recursive: true });
        symlinkSync(destination, linkPath, 'junction');
        links.push({ agent: agent.key, label: agent.label, state: 'linked', message: `已链接到 ${agent.label}` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        links.push({ agent: agent.key, label: agent.label, state: 'failed', message });
        warnings.push(`${agent.label} 链接失败：${message}`);
      }
    }

    const linkedLabels = links.filter((link) => link.state === 'linked').map((link) => link.label);
    const message =
      linkedLabels.length > 0
        ? `已安装 ${name} 到源，并链接到 ${linkedLabels.join('、')}`
        : `已安装 ${name} 到源`;

    return {
      message,
      name,
      path: destination,
      files: written.files,
      bytes: written.bytes,
      snapshotId: snapshot.id,
      links,
      warnings,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
