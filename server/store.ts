import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { AppError } from '../shared/types.ts';
import type {
  AgentSpec,
  McpMatrixReport,
  McpServerDefinition,
  McpTransport,
  SettingsFileDescriptor,
  StoreInstallLink,
  StoreInstallReport,
  StoreInstallRequest,
  StoreListing,
  StoreMcpInstallRequest,
  StoreMcpInstallResponse,
  StoreMcpOption,
  StoreMcpReport,
  StoreMcpServer,
  StoreMcpVariable,
  StoreRisk,
  StoreSkill,
  StoreSkillDetail,
  StoreSkillReport,
} from '../shared/types.ts';
import { moveDirectory } from './actions.ts';
import { listMcpSourceNames, normalizeDefinition, runMcpAction, validateServerName } from './mcp.ts';
import { hasSkillFile, isInside } from './scan.ts';
import { createSnapshot, markSnapshotFailed } from './snapshot.ts';
import { unzip } from './zip.ts';

export type {
  StoreInstallLink,
  StoreInstallReport,
  StoreInstallRequest,
  StoreListing,
  StoreMcpInstallRequest,
  StoreMcpInstallResponse,
  StoreMcpOption,
  StoreMcpReport,
  StoreMcpServer,
  StoreMcpVariable,
  StoreSkill,
  StoreSkillDetail,
  StoreSkillReport,
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
async function fetchWithRetry(
  url: string,
  fetchImpl: typeof fetch,
  accept: string,
  label = '技能商店',
): Promise<Response> {
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
  throw new AppError(502, `${label}请求失败（${lastError}）`);
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

interface StoreCacheEntry<T> {
  key: string;
  at: number;
  items: T[];
  total: number;
  totalPages: number;
  nextCursor?: string;
}

const skillCache = new Map<string, StoreCacheEntry<StoreSkill>>();
const mcpCache = new Map<string, StoreCacheEntry<StoreMcpServer>>();

/** Both catalogs share the same freshness window and cache size. */
function cacheGet<T>(entries: Map<string, StoreCacheEntry<T>>, key: string): StoreCacheEntry<T> | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > CACHE_TTL_MS * 10) {
    entries.delete(key);
    return undefined;
  }
  return entry;
}

function cacheSet<T>(entries: Map<string, StoreCacheEntry<T>>, entry: StoreCacheEntry<T>): void {
  entries.delete(entry.key);
  entries.set(entry.key, entry);
  while (entries.size > CACHE_LIMIT) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/** What the skill catalog can be narrowed by. The registry applies these to the whole catalog. */
export interface StoreSkillFilters {
  category?: string;
  risk?: StoreRisk;
  hasScripts?: boolean;
}

const CATEGORY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const RISK_VALUES: readonly string[] = ['safe', 'medium', 'high', 'critical'];

/**
 * Keeps only the values the registry understands, so a stale or hand-edited query reads as "no
 * filter" instead of coming back as a registry error.
 */
export function readSkillFilters(input: {
  category?: string;
  risk?: string;
  hasScripts?: boolean;
}): StoreSkillFilters {
  const category = (input.category ?? '').trim().toLowerCase();
  const risk = (input.risk ?? '').trim().toLowerCase();
  return {
    ...(CATEGORY_PATTERN.test(category) ? { category } : {}),
    ...(RISK_VALUES.includes(risk) ? { risk: risk as StoreRisk } : {}),
    ...(input.hasScripts === true ? { hasScripts: true } : {}),
  };
}

/**
 * The registry filters server-side; this pass repeats it over the rows it answered with, so a
 * registry that starts ignoring a parameter shows an empty page instead of unrelated skills.
 */
export function matchSkillFilters(items: StoreSkill[], filters: StoreSkillFilters): StoreSkill[] {
  if (filters.category === undefined && filters.risk === undefined && filters.hasScripts === undefined) {
    return items;
  }
  return items.filter(
    (item) =>
      (filters.category === undefined || item.category === filters.category) &&
      (filters.risk === undefined || item.risk === filters.risk) &&
      (filters.hasScripts === undefined || item.hasScripts === true),
  );
}

export interface StoreInput {
  query?: string;
  /** 1-based page of the registry result set. */
  page?: number;
  limit?: number;
  refresh?: boolean;
  /** Whole-catalog filters: the registry narrows the result set before it pages it. */
  category?: string;
  risk?: string;
  hasScripts?: boolean;
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
}): StoreSkillReport {
  const present = new Set(input.sourceSkills);
  return {
    kind: 'skill',
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
export async function getStoreReport(input: StoreInput = {}): Promise<StoreSkillReport> {
  const query = (input.query ?? '').trim().slice(0, 120);
  const limit = Math.min(50, Math.max(1, Math.round(input.limit ?? 12)));
  const page = Math.max(1, Math.round(input.page ?? 1));
  const listing: StoreListing = query === '' ? 'featured' : 'search';
  const sourcePath = input.sourcePath ?? '';
  const fetchedAt = new Date(input.now?.() ?? Date.now()).toISOString();
  const sourceSkills = input.sourceSkills ?? [];
  const filters = readSkillFilters(input);

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

  const key = `${base}|${listing}|${query}|${limit}|${page}|${filters.category ?? ''}|${filters.risk ?? ''}|${filters.hasScripts === true ? '1' : ''}`;
  if (!input.refresh) {
    const hit = cacheGet(skillCache, key);
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
    ...(filters.category === undefined ? {} : { category: filters.category }),
    ...(filters.risk === undefined ? {} : { risk: filters.risk }),
    ...(filters.hasScripts === undefined ? {} : { hasScripts: 'true' }),
  });

  try {
    const response = await fetchWithRetry(url, input.fetchImpl ?? fetch, 'application/json');
    const payload = await response.json();
    const record = asRecord(payload);
    const total = asNumber(record.total);
    const registryPage = asRecord(record.pagination);
    const totalPages =
      asNumber(registryPage.totalPages) || Math.max(1, Math.ceil(total / limit));
    const items = matchSkillFilters(rankStoreSkills(normalizeStoreSkills(payload), query), filters);
    cacheSet(skillCache, { key, at: Date.now(), items, total, totalPages });
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
    const hit = cacheGet(skillCache, key);
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

/** Trimmed, non-empty strings from an array; anything else is ignored. */
function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => asString(entry).trim()).filter((entry) => entry !== '')
    : [];
}

export interface StoreSkillDetailInput {
  slug: string;
  /** Skill directory names already in the source, so the dialog can mark the install. */
  sourceSkills?: string[];
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Loads one skill's full record. The listing row is enough for a card; the dialog wants the
 * whole description, the AI review (capabilities, limits, use cases) and the file list.
 */
export async function getStoreSkillDetail(input: StoreSkillDetailInput): Promise<StoreSkillDetail> {
  const slug = input.slug.trim();
  if (!SLUG_PATTERN.test(slug)) throw new AppError(400, '技能 slug 不合法');
  const base = storeBaseUrl(input.baseUrl);
  const response = await fetchWithRetry(
    registryUrl(base, `/api/skills/${encodeURIComponent(slug)}`),
    input.fetchImpl ?? fetch,
    'application/json',
  );
  const payload: unknown = await response.json();
  const record = asRecord(asRecord(payload).data ?? payload);
  const skill = normalizeStoreSkill(record);
  if (skill === null) throw new AppError(502, '技能商店返回的详情无法识别');

  const name = asString(record.displayName) || asString(record.name) || skill.name;
  const ai = asRecord(record.aiContent);
  const audit = asRecord(record.securityAudit);
  const presented = new Set(input.sourceSkills ?? []);
  const files = registryEntries(record.fileStructure).flatMap((file) => {
    const path = asString(file.path);
    if (path === '') return [];
    const lines = asNumber(file.lines);
    return [{ path, type: asString(file.type) || 'file', ...(lines === 0 ? {} : { lines }) }];
  });
  const useCases = registryEntries(ai.use_cases).flatMap((entry) => {
    const title = asString(entry.title);
    const description = asString(entry.description);
    return title === '' && description === '' ? [] : [{ title, description }];
  });
  const aiTitle = asString(ai.user_title);
  const aiSummary = asString(record.summary);
  const valueStatement = asString(ai.value_statement);
  const securitySummary = asString(audit.summary);

  return {
    ...skill,
    name,
    inSource: presented.has(name) || presented.has(slug),
    ...(aiTitle === '' ? {} : { aiTitle }),
    ...(aiSummary === '' ? {} : { aiSummary }),
    ...(valueStatement === '' ? {} : { valueStatement }),
    capabilities: stringList(ai.actual_capabilities),
    limitations: stringList(ai.limitations),
    useCases,
    files,
    ...(securitySummary === '' ? {} : { securitySummary }),
    riskFactors: stringList(record.riskFactors),
    viewCount: asNumber(asRecord(record.stats).viewCount),
  };
}

/** Test hook: drop the in-memory listing cache. */
export function clearStoreCache(): void {
  skillCache.clear();
  mcpCache.clear();
}

// ---- MCP catalog (official registry) ----
//
// `registry.modelcontextprotocol.io` speaks one search endpoint: `/v0/servers?limit&search&cursor`.
// It reports no total and pages by cursor, so this catalog has no page numbers. Any mirror that
// implements the same route can be swapped in with `AGENT_MANAGER_MCP_STORE_URL`.

const DEFAULT_MCP_BASE_URL = 'https://registry.modelcontextprotocol.io';
const MCP_MAX_LIMIT = 100;
/** The registry ignores `search` shorter than this, so the page refuses it instead of guessing. */
const MCP_MIN_SEARCH = 3;

/** The registry mirror base URL: env override, always http(s), never with a trailing slash. */
export function mcpStoreBaseUrl(override?: string): string {
  const raw = (override ?? process.env.AGENT_MANAGER_MCP_STORE_URL ?? DEFAULT_MCP_BASE_URL).trim();
  const trimmed = raw.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) throw new AppError(400, 'MCP 商店地址必须是 http(s) URL');
  return trimmed;
}

function registryEntries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map((entry) => asRecord(entry)) : [];
}

function inputDescription(record: Record<string, unknown>): { description?: string } {
  const description = asString(record.description).trim();
  return description === '' ? {} : { description };
}

/** Suggested servers.json key: the tail of the reverse-DNS name, cleaned for a JSON key. */
function installNameFor(tail: string): string {
  const cleaned = tail.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100);
  return cleaned === '' ? 'mcp-server' : cleaned;
}

/**
 * Expands registry argument values into a command line. `null` means the option cannot run
 * without something the dialog has no way to ask for, so the whole option is dropped.
 */
function argumentList(value: unknown): string[] | null {
  const args: string[] = [];
  for (const argument of registryEntries(value)) {
    const name = asString(argument.name);
    const supplied = asString(argument.value) || asString(argument.default);
    if (supplied === '') {
      if (argument.isRequired === true) return null;
      continue;
    }
    if (asString(argument.type) === 'named' && name !== '') args.push(name, supplied);
    else args.push(supplied);
  }
  return args;
}

/**
 * Splits env/header inputs into values that are already known (defaults) and values the dialog
 * must ask for. Optional inputs without a default are simply omitted. A value may itself be a
 * template (`Bearer {api_key}`); declared variables that carry a default are filled in, and the
 * remaining `{token}` placeholders become dialog variables that the dialog substitutes.
 */
function resolveInputs(
  value: unknown,
  target: 'env' | 'header',
): { values: Record<string, string>; variables: StoreMcpVariable[] } {
  const values: Record<string, string> = {};
  const variables: StoreMcpVariable[] = [];
  const seen = new Set<string>();
  const addVariable = (variable: StoreMcpVariable) => {
    const key = `${variable.target}:${variable.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    variables.push(variable);
  };
  for (const input of registryEntries(value)) {
    const name = asString(input.name);
    if (name === '') continue;
    const declared = asRecord(input.variables);
    let supplied = asString(input.value) || asString(input.default);
    for (const [token, entry] of Object.entries(declared)) {
      const resolved = asString(asRecord(entry).value) || asString(asRecord(entry).default);
      if (resolved !== '') supplied = supplied.replaceAll(`{${token}}`, resolved);
    }
    if (supplied === '') {
      if (input.isRequired !== true) continue;
      addVariable({
        target,
        name,
        ...inputDescription(input),
        ...(input.isSecret === true ? { isSecret: true } : {}),
      });
      continue;
    }
    const tokens = [
      ...new Set([...supplied.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1] ?? '')),
    ];
    // An optional template nobody declared is left out rather than saved as a broken value.
    if (tokens.length > 0 && input.isRequired !== true) continue;
    values[name] = supplied;
    for (const token of tokens) {
      const spec = asRecord(declared[token]);
      const description = asString(spec.description).trim() || asString(input.description).trim();
      addVariable({
        target: 'template',
        name: token,
        ...(description === '' ? {} : { description }),
        ...(input.isSecret === true || spec.isSecret === true ? { isSecret: true } : {}),
      });
    }
  }
  return { values, variables };
}

/**
 * Fills a remote URL's `{name}` tokens with registry defaults. Required tokens without a default
 * stay in place and become dialog variables; a token the registry never declared makes the
 * option unusable.
 */
function resolveRemoteUrl(
  template: string,
  value: unknown,
): { url: string; variables: StoreMcpVariable[] } | null {
  const declared = asRecord(value);
  let url = template;
  const variables: StoreMcpVariable[] = [];
  for (const [name, entry] of Object.entries(declared)) {
    const variable = asRecord(entry);
    const supplied = asString(variable.value) || asString(variable.default);
    if (supplied !== '') {
      url = url.replaceAll(`{${name}}`, supplied);
      continue;
    }
    if (variable.isRequired !== true) {
      url = url.replaceAll(`{${name}}`, '');
      continue;
    }
    variables.push({ target: 'url', name, ...inputDescription(variable) });
  }
  for (const match of url.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
    if (!Object.hasOwn(declared, match[1] ?? '')) return null;
  }
  return { url, variables };
}

function packageOption(pkg: Record<string, unknown>): StoreMcpOption | null {
  const registryType = asString(pkg.registryType);
  const identifier = asString(pkg.identifier);
  if (identifier === '') return null;
  // A package that serves HTTP needs a running process; saving a remote URL would not start it.
  const transport = asString(asRecord(pkg.transport).type);
  if (transport !== '' && transport !== 'stdio') return null;

  const version = asString(pkg.version);
  const runtimeHint = asString(pkg.runtimeHint);
  const runtime = argumentList(pkg.runtimeArguments);
  const extra = argumentList(pkg.packageArguments);
  if (runtime === null || extra === null) return null;
  const inputs = resolveInputs(pkg.environmentVariables, 'env');

  let command: string;
  let args: string[];
  switch (registryType) {
    case 'npm':
      command = runtimeHint || 'npx';
      args = ['-y', version === '' ? identifier : `${identifier}@${version}`, ...runtime, ...extra];
      break;
    case 'pypi':
      command = runtimeHint || 'uvx';
      args = [version === '' ? identifier : `${identifier}==${version}`, ...runtime, ...extra];
      break;
    case 'oci':
      command = runtimeHint || 'docker';
      // The OCI identifier already carries its tag.
      args = ['run', '-i', '--rm', ...runtime, identifier, ...extra];
      break;
    default:
      return null;
  }

  return {
    id: `pkg:${registryType}:${identifier}${version === '' ? '' : `@${version}`}`,
    label: `${registryType} ${version === '' ? identifier : `${identifier}@${version}`}`,
    transport: 'stdio',
    server: {
      transport: 'stdio',
      command,
      ...(args.length === 0 ? {} : { args }),
      ...(Object.keys(inputs.values).length === 0 ? {} : { env: inputs.values }),
    },
    variables: inputs.variables,
  };
}

function remoteOption(remote: Record<string, unknown>): StoreMcpOption | null {
  const type = asString(remote.type);
  const transport: McpTransport | null =
    type === 'streamable-http' || type === 'http' ? 'http' : type === 'sse' ? 'sse' : null;
  if (transport === null) return null;

  const template = asString(remote.url);
  if (!/^https?:\/\//i.test(template)) return null;
  const resolved = resolveRemoteUrl(template, remote.variables);
  if (resolved === null) return null;

  const inputs = resolveInputs(remote.headers, 'header');
  let host = resolved.url;
  try {
    host = new URL(resolved.url).host;
  } catch {
    // Keep the raw URL when it is still incomplete.
  }

  return {
    id: `remote:${transport}:${resolved.url}`,
    label: `${transport} ${host}`,
    transport,
    server: {
      transport,
      url: resolved.url,
      ...(Object.keys(inputs.values).length === 0 ? {} : { headers: inputs.values }),
    },
    variables: [...resolved.variables, ...inputs.variables],
  };
}

/** Maps one `/v0/servers` row (`{server, _meta}`) into the card the page renders. */
export function normalizeMcpServer(raw: unknown): StoreMcpServer | null {
  const entry = asRecord(raw);
  const server = asRecord(entry.server);
  const meta = asRecord(entry._meta);
  const id = asString(server.name);
  if (id === '') return null;
  if (asString(meta.status) === 'deleted') return null;

  const slash = id.lastIndexOf('/');
  const owner = slash === -1 ? '' : id.slice(0, slash);
  const tail = slash === -1 ? id : id.slice(slash + 1);

  const options: StoreMcpOption[] = [];
  const add = (option: StoreMcpOption | null): void => {
    if (option !== null && !options.some((current) => current.id === option.id)) options.push(option);
  };
  for (const pkg of registryEntries(server.packages)) add(packageOption(pkg));
  for (const remote of registryEntries(server.remotes)) add(remoteOption(remote));

  const version = asString(server.version);
  const repository = asString(asRecord(server.repository).url) || asString(server.repositoryUrl);
  const websiteUrl = asString(server.websiteUrl);
  const updatedAt = isoTimestamp(meta.updatedAt) ?? isoTimestamp(meta.publishedAt);

  return {
    id,
    name: asString(server.title) || tail,
    owner,
    installName: installNameFor(tail),
    summary: asString(server.description),
    ...(version === '' ? {} : { version }),
    ...(repository === '' ? {} : { repository }),
    ...(websiteUrl === '' ? {} : { websiteUrl }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    options,
    inSource: false,
  };
}

/** Same mapping for a whole payload, with duplicate reverse-DNS names collapsed. */
export function normalizeMcpServers(payload: unknown): StoreMcpServer[] {
  const record = asRecord(payload);
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(record.servers)
      ? (record.servers as unknown[])
      : [];
  const servers = new Map<string, StoreMcpServer>();
  for (const entry of list) {
    const server = normalizeMcpServer(entry);
    if (server && !servers.has(server.id)) servers.set(server.id, server);
  }
  return [...servers.values()];
}

export interface McpStoreInput {
  query?: string;
  cursor?: string;
  limit?: number;
  refresh?: boolean;
  /** Keys already in ~/.agents/mcp/servers.json, so the page can mark them. */
  sourceNames?: string[];
  sourcePath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  baseUrl?: string;
}

function mcpReport(input: {
  items: StoreMcpServer[];
  sourceNames: string[];
  sourcePath: string;
  baseUrl: string;
  query: string;
  listing: StoreListing;
  limit: number;
  nextCursor?: string;
  fetchedAt: string;
  cached: boolean;
  stale?: boolean;
  error?: string;
}): StoreMcpReport {
  const present = new Set(input.sourceNames);
  return {
    kind: 'mcp',
    provider: 'MCP Registry',
    endpoint: input.baseUrl,
    query: input.query,
    listing: input.listing,
    // The registry pages by cursor and has no page numbers; the page keeps the cursor history.
    page: 1,
    limit: input.limit,
    totalPages: 1,
    total: 0,
    ...(input.nextCursor === undefined || input.nextCursor === '' ? {} : { nextCursor: input.nextCursor }),
    fetchedAt: input.fetchedAt,
    cached: input.cached,
    ...(input.stale === undefined ? {} : { stale: input.stale }),
    ...(input.error === undefined ? {} : { error: input.error }),
    sourcePath: input.sourcePath,
    items: input.items.map((item) => ({ ...item, inSource: present.has(item.installName) })),
  };
}

/**
 * Fetches one page of the official MCP registry. Like the skills catalog this returns an `error`
 * report (with the last cached page when there is one) instead of throwing, so the page survives
 * a registry outage.
 */
export async function getMcpStoreReport(input: McpStoreInput = {}): Promise<StoreMcpReport> {
  const query = (input.query ?? '').trim().slice(0, 120);
  const cursor = (input.cursor ?? '').trim();
  const limit = Math.min(MCP_MAX_LIMIT, Math.max(1, Math.round(input.limit ?? 24)));
  const listing: StoreListing = query === '' ? 'featured' : 'search';
  const fetchedAt = new Date(input.now?.() ?? Date.now()).toISOString();
  const sourceNames = input.sourceNames ?? [];
  const sourcePath = input.sourcePath ?? '';
  const rawBase = (input.baseUrl ?? process.env.AGENT_MANAGER_MCP_STORE_URL ?? DEFAULT_MCP_BASE_URL).trim();

  let base: string;
  try {
    base = mcpStoreBaseUrl(input.baseUrl);
  } catch (error) {
    return mcpReport({
      items: [],
      sourceNames,
      sourcePath,
      baseUrl: rawBase,
      query,
      listing,
      limit,
      fetchedAt,
      cached: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (query !== '' && query.length < MCP_MIN_SEARCH) {
    return mcpReport({
      items: [],
      sourceNames,
      sourcePath,
      baseUrl: base,
      query,
      listing,
      limit,
      fetchedAt,
      cached: false,
      error: `MCP 商店的搜索至少需要 ${MCP_MIN_SEARCH} 个字符`,
    });
  }

  const key = `${base}|mcp|${listing}|${query}|${limit}|${cursor}`;
  if (!input.refresh) {
    const hit = cacheGet(mcpCache, key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return mcpReport({
        items: hit.items,
        sourceNames,
        sourcePath,
        baseUrl: base,
        query,
        listing,
        limit,
        nextCursor: hit.nextCursor,
        fetchedAt,
        cached: true,
      });
    }
  }

  const url = registryUrl(base, '/v0/servers', {
    limit,
    version: 'latest',
    ...(query === '' ? {} : { search: query }),
    ...(cursor === '' ? {} : { cursor }),
  });

  try {
    const response = await fetchWithRetry(url, input.fetchImpl ?? fetch, 'application/json', 'MCP 商店');
    const payload = await response.json();
    const items = normalizeMcpServers(payload);
    const nextCursor = asString(asRecord(asRecord(payload).metadata).nextCursor);
    cacheSet(mcpCache, { key, at: Date.now(), items, total: 0, totalPages: 1, nextCursor });
    return mcpReport({
      items,
      sourceNames,
      sourcePath,
      baseUrl: base,
      query,
      listing,
      limit,
      nextCursor,
      fetchedAt,
      cached: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hit = cacheGet(mcpCache, key);
    if (hit) {
      return mcpReport({
        items: hit.items,
        sourceNames,
        sourcePath,
        baseUrl: base,
        query,
        listing,
        limit,
        nextCursor: hit.nextCursor,
        fetchedAt,
        cached: true,
        stale: true,
        error: message,
      });
    }
    return mcpReport({
      items: [],
      sourceNames,
      sourcePath,
      baseUrl: base,
      query,
      listing,
      limit,
      fetchedAt,
      cached: false,
      error: message,
    });
  }
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
 * Stages, snapshots, moves and links an already-supplied skill. The registry install and the
 * built-in install share it, so a failed link rolls the whole operation back either way.
 */
export interface SkillEntriesInstallInput {
  source: string;
  snapshotRoot: string;
  tempRoot: string;
  /** Already resolved and validated against the configured agents. */
  agents: AgentSpec[];
  name: string;
  /** Snapshot label, e.g. `install acme/pdf-tools`. */
  label: string;
  entries: { name: string; data: Buffer }[];
}

export function installSkillEntries(input: SkillEntriesInstallInput): StoreInstallReport {
  if (input.entries.length === 0) throw new AppError(400, `安装包是空的（${input.name}）`);
  const destination = join(input.source, input.name);
  if (lstatOrNull(destination) || existsSync(destination)) {
    throw new AppError(409, `源里已经有 ${input.name}，先移除它（或换个名字）再安装`);
  }

  // An existing entry is never replaced: that decision belongs to the skills page.
  const targets = input.agents.map((agent) => ({
    agent,
    skip: lstatOrNull(join(agent.root, input.name)) !== null,
  }));

  mkdirSync(input.tempRoot, { recursive: true });
  const staging = mkdtempSync(join(input.tempRoot, 'store-'));
  try {
    const written = extractZipEntries(input.entries, staging);
    if (!hasSkillFile(staging)) {
      throw new AppError(400, `安装包里没有 SKILL.md，不是可安装的 skill（${input.name}）`);
    }

    const snapshot = createSnapshot(
      input.snapshotRoot,
      input.label,
      [],
      [destination, ...targets.filter((target) => !target.skip).map((target) => join(target.agent.root, input.name))],
      new Date(),
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
    // Links this install created, so a later failure can take them back out.
    const createdLinks: string[] = [];

    for (const { agent, skip } of targets) {
      const linkPath = join(agent.root, input.name);
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
        createdLinks.push(linkPath);
        links.push({ agent: agent.key, label: agent.label, state: 'linked', message: `已链接到 ${agent.label}` });
      } catch (error) {
        // A link that failed for a reason other than a concurrent entry (EPERM without Developer
        // Mode, an unsupported filesystem) would leave the skill in the source, unlinked, and the
        // matrix would show every agent as "missing". Roll the whole install back instead.
        if (lstatOrNull(linkPath) !== null) {
          links.push({ agent: agent.key, label: agent.label, state: 'skipped', message: `${agent.label} 里已有同名条目，未改动` });
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        for (const path of createdLinks) {
          try { unlinkSync(path); } catch { /* best effort; the snapshot still records it */ }
        }
        rmSync(destination, { recursive: true, force: true });
        markSnapshotFailed(input.snapshotRoot, snapshot.id);
        throw new AppError(500, `链接到 ${agent.label} 失败，已撤销本次安装：${message}`);
      }
    }

    const linkedLabels = links.filter((link) => link.state === 'linked').map((link) => link.label);
    const message =
      linkedLabels.length > 0
        ? `已安装 ${input.name} 到源，并链接到 ${linkedLabels.join('、')}`
        : `已安装 ${input.name} 到源`;

    return {
      message,
      name: input.name,
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

  return installSkillEntries({
    source: input.source,
    snapshotRoot: input.snapshotRoot,
    tempRoot: input.tempRoot,
    agents: resolved,
    name,
    label: `install ${owner === '' ? slug : `${owner}/${name}`}`,
    entries,
  });
}

// ---- installing an MCP server ----

export interface StoreMcpInstallInput {
  sourcePath: string;
  snapshotRoot: string;
  settingsFiles: SettingsFileDescriptor[];
  request: StoreMcpInstallRequest;
}

/**
 * Saves a registry server into the MCP source and syncs the selected agents. The definition comes
 * from the install dialog, which has already filled every value the registry marked required.
 * `runMcpAction` takes the source snapshot and one snapshots per agent file it rewrites.
 */
export function installStoreMcp(input: StoreMcpInstallInput): StoreMcpInstallResponse {
  const name = validateServerName(String(input.request.name ?? '').trim());
  const server = normalizeDefinition(input.request.server, name);
  if (listMcpSourceNames(input.sourcePath).includes(name)) {
    throw new AppError(409, `MCP 源里已经有 ${name}，先移除它（或换个名字）再安装`);
  }

  const result = runMcpAction(
    {
      sourcePath: input.sourcePath,
      snapshotRoot: input.snapshotRoot,
      settingsFiles: input.settingsFiles,
    },
    { action: 'saveSource', name, server, agents: input.request.agents ?? [] },
  );

  return {
    message: result.message,
    name,
    snapshotIds: result.snapshotIds,
    warnings: result.warnings,
    report: result.report,
  };
}
