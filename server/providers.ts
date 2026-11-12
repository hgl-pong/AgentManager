import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { AppError } from '../shared/types.ts';
import type {
  ModelsReport,
  ProviderModelsReport,
  ProviderMutationResponse,
  ProviderSaveRequest,
  ProvidersReport,
  ProviderSummary,
} from '../shared/types.ts';
import { createSnapshot, markSnapshotFailed } from './snapshot.ts';
import { getModelsReport } from './models.ts';
import { writeAtomically } from './settings.ts';

interface StoredProvider {
  id: string;
  baseUrl: string;
  apiKey: string;
  createdAt: string;
  updatedAt: string;
}

interface ProviderStore {
  activeId: string | null;
  providers: StoredProvider[];
}

const EMPTY_STORE: ProviderStore = { activeId: null, providers: [] };

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) throw new AppError(400, 'Base URL 必须是 http(s) URL');
  try {
    new URL(trimmed);
  } catch {
    throw new AppError(400, `Base URL 无法解析：${trimmed}`);
  }
  return trimmed;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl;
  }
}

function asProvider(value: unknown): StoredProvider | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id === '') return null;
  if (typeof record.baseUrl !== 'string' || record.baseUrl === '') return null;
  if (typeof record.apiKey !== 'string') return null;
  return {
    id: record.id,
    baseUrl: record.baseUrl,
    apiKey: record.apiKey,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString(),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
  };
}

/** Reads the provider source. A malformed file is an error, never silently discarded. */
function readStore(path: string): ProviderStore {
  if (!existsSync(path)) return { ...EMPTY_STORE, providers: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new AppError(500, `provider 文件无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError(500, 'provider 文件格式无效');
  }
  const record = parsed as Record<string, unknown>;
  const rawList = Array.isArray(record.providers) ? record.providers : [];
  const providers = rawList.map(asProvider);
  if (providers.some((entry) => entry === null)) {
    throw new AppError(500, 'provider 文件里有无效条目');
  }
  const activeId = typeof record.activeId === 'string' ? record.activeId : null;
  return { activeId, providers: providers as StoredProvider[] };
}

function effectiveActiveId(store: ProviderStore): string | null {
  if (store.activeId && store.providers.some((provider) => provider.id === store.activeId)) {
    return store.activeId;
  }
  return store.providers[0]?.id ?? null;
}

function publicSummary(provider: StoredProvider, activeId: string | null): ProviderSummary {
  return {
    id: provider.id,
    baseUrl: provider.baseUrl,
    host: hostOf(provider.baseUrl),
    hasApiKey: provider.apiKey.trim() !== '',
    active: provider.id === activeId,
    updatedAt: provider.updatedAt,
  };
}

function reportFor(path: string, store: ProviderStore): ProvidersReport {
  const activeId = effectiveActiveId(store);
  return {
    source: path,
    activeId,
    providers: store.providers.map((provider) => publicSummary(provider, activeId)),
  };
}

function writeStore(path: string, store: ProviderStore): void {
  writeAtomically(path, `${JSON.stringify(store, null, 2)}\n`);
  try {
    // Best effort on Windows; POSIX honours the mode.
    chmodSync(path, 0o600);
  } catch {
    // The file is still local to this user; do not fail the save for a chmod quirk.
  }
}

/** Writes a snapshot for the provider file, then performs the mutation. */
function mutate(
  path: string,
  snapshotRoot: string,
  operation: string,
  store: ProviderStore,
): string {
  const existed = existsSync(path);
  const snapshot = createSnapshot(
    snapshotRoot,
    operation,
    existed ? [path] : [],
    existed ? [] : [path],
  );
  try {
    writeStore(path, store);
  } catch (error) {
    markSnapshotFailed(snapshotRoot, snapshot.id);
    throw error;
  }
  return snapshot.id;
}

export function listProviders(path: string): ProvidersReport {
  return reportFor(path, readStore(path));
}

export function saveProvider(
  path: string,
  snapshotRoot: string,
  input: ProviderSaveRequest,
): ProviderMutationResponse {
  const baseUrl = normalizeBaseUrl(typeof input.baseUrl === 'string' ? input.baseUrl : '');
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const store = readStore(path);
  const now = new Date().toISOString();

  let provider: StoredProvider;
  if (input.id !== undefined) {
    const existing = store.providers.find((entry) => entry.id === input.id);
    if (!existing) throw new AppError(404, `没有这个 provider：${input.id}`);
    provider = {
      ...existing,
      baseUrl,
      apiKey: apiKey === '' ? existing.apiKey : apiKey,
      updatedAt: now,
    };
    store.providers = store.providers.map((entry) => (entry.id === existing.id ? provider : entry));
  } else {
    if (apiKey === '') throw new AppError(400, '新 provider 必须填写 API key');
    let id = `provider-${randomBytes(4).toString('hex')}`;
    while (store.providers.some((entry) => entry.id === id)) {
      id = `provider-${randomBytes(4).toString('hex')}`;
    }
    provider = { id, baseUrl, apiKey, createdAt: now, updatedAt: now };
    store.providers.push(provider);
    // Adding a provider is the intent to use it; making it active saves a second click.
    store.activeId = id;
  }

  const snapshotId = mutate(
    path,
    snapshotRoot,
    `save provider ${hostOf(provider.baseUrl)}`,
    store,
  );
  return {
    message: `已保存 provider ${hostOf(provider.baseUrl)}`,
    snapshotId,
    report: reportFor(path, store),
  };
}

export function activateProvider(
  path: string,
  snapshotRoot: string,
  id: string,
): ProviderMutationResponse {
  const store = readStore(path);
  const provider = store.providers.find((entry) => entry.id === id);
  if (!provider) throw new AppError(404, `没有这个 provider：${id}`);
  if (store.activeId === id) {
    return { message: `${hostOf(provider.baseUrl)} 已经是当前 provider`, snapshotId: '', report: reportFor(path, store) };
  }
  store.activeId = id;
  const snapshotId = mutate(path, snapshotRoot, `activate provider ${hostOf(provider.baseUrl)}`, store);
  return {
    message: `已切换到 ${hostOf(provider.baseUrl)}`,
    snapshotId,
    report: reportFor(path, store),
  };
}

export function removeProvider(
  path: string,
  snapshotRoot: string,
  id: string,
): ProviderMutationResponse {
  const store = readStore(path);
  const provider = store.providers.find((entry) => entry.id === id);
  if (!provider) throw new AppError(404, `没有这个 provider：${id}`);
  store.providers = store.providers.filter((entry) => entry.id !== id);
  if (store.activeId === id) store.activeId = store.providers[0]?.id ?? null;
  const snapshotId = mutate(path, snapshotRoot, `remove provider ${hostOf(provider.baseUrl)}`, store);
  return {
    message: `已删除 provider ${hostOf(provider.baseUrl)}`,
    snapshotId,
    report: reportFor(path, store),
  };
}

function activeProvider(store: ProviderStore): StoredProvider | null {
  if (store.activeId) {
    const found = store.providers.find((entry) => entry.id === store.activeId);
    if (found) return found;
  }
  return store.providers[0] ?? null;
}

/** Fetches the active provider's model list. The stored key is only sent to that endpoint. */
export async function getProviderModels(
  path: string,
  refresh = false,
  fetchImpl?: typeof fetch,
): Promise<ProviderModelsReport> {
  const store = readStore(path);
  const provider = activeProvider(store);
  if (!provider) {
    return {
      source: '',
      fetchedAt: new Date().toISOString(),
      cached: false,
      error: '还没有配置 provider',
      models: [],
      provider: null,
    };
  }
  const report = await getModelsReport({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    refresh,
    cacheKey: `provider:${provider.id}:${provider.updatedAt}`,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return { ...report, provider: publicSummary(provider, effectiveActiveId(store)) };
}

/** Checks whether the provider file currently names an active provider, without exposing keys. */
export function hasProvider(path: string): boolean {
  return activeProvider(readStore(path)) !== null;
}

