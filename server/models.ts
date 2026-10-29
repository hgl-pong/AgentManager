import type { ModelInfo, ModelsReport } from '../shared/types.ts';

const DEFAULT_BASE_URL = 'http://127.0.0.1:15721/v1';
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

export type { ModelInfo, ModelsReport } from '../shared/types.ts';

interface CacheEntry {
  url: string;
  fetchedAt: number;
  report: ModelsReport;
}

let cache: CacheEntry | null = null;

/** Builds the OpenAI-compatible /models URL from a base URL or a full URL. */
export function modelsUrl(base = process.env.AGENT_MANAGER_MODELS_URL ?? DEFAULT_BASE_URL): string {
  const trimmed = base.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) throw new Error('模型源必须是 http(s) URL');
  return /\/models$/i.test(trimmed) ? trimmed : `${trimmed}/models`;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function capabilityFlag(value: unknown): boolean | undefined {
  if (value === true || value === false) return value;
  if (value && typeof value === 'object' && typeof (value as { supported?: unknown }).supported === 'boolean') {
    return (value as { supported: boolean }).supported;
  }
  return undefined;
}

function rawList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    for (const key of ['data', 'models']) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [];
}

/** Normalizes OpenAI-style `{data:[...]}` and Codex-style `{models:[...]}` payloads. */
export function normalizeModels(payload: unknown): ModelInfo[] {
  const models = new Map<string, ModelInfo>();
  for (const raw of rawList(payload)) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : typeof record.slug === 'string' ? record.slug : '';
    if (!id) continue;
    const capabilities = (record.capabilities ?? {}) as Record<string, unknown>;
    const compat = (record.compat ?? {}) as Record<string, unknown>;
    const contextWindow =
      asNumber(record.max_input_tokens) ?? asNumber(record.context_window) ?? asNumber(record.contextWindow);
    const maxOutputTokens =
      asNumber(record.max_tokens) ?? asNumber(record.max_output_tokens) ?? asNumber(record.maxOutputTokens);
    const input = Array.isArray(record.input) ? record.input.map(String) : [];
    const slash = id.indexOf('/');
    models.set(id, {
      id,
      name: typeof record.display_name === 'string' ? record.display_name : typeof record.name === 'string' ? record.name : id,
      group: slash > 0 ? id.slice(0, slash) : 'default',
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      thinking:
        capabilityFlag(capabilities.thinking) ??
        capabilityFlag(record.thinking) ??
        record.reasoning === true,
      effort:
        capabilityFlag(capabilities.effort) ??
        capabilityFlag(compat.supportsReasoningEffort) ??
        capabilityFlag(record.supports_reasoning_effort) ??
        false,
      imageInput: capabilityFlag(capabilities.image_input) ?? input.includes('image'),
      pdfInput: capabilityFlag(capabilities.pdf_input) ?? input.includes('pdf'),
    });
  }

  return [...models.values()].sort((a, b) => {
    if (a.group !== b.group) return a.group === 'default' ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

export interface ModelsInput {
  refresh?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Fetches the model catalog from the local OpenAI-compatible endpoint. Failures return a
 * report with `error` instead of throwing, so the settings page can fall back to free text.
 */
export async function getModelsReport(input: ModelsInput = {}): Promise<ModelsReport> {
  let url: string;
  try {
    url = modelsUrl();
  } catch (error) {
    return {
      source: process.env.AGENT_MANAGER_MODELS_URL ?? DEFAULT_BASE_URL,
      fetchedAt: new Date(input.now?.() ?? Date.now()).toISOString(),
      cached: false,
      error: error instanceof Error ? error.message : String(error),
      models: [],
    };
  }

  const now = input.now?.() ?? Date.now();
  if (!input.refresh && cache && cache.url === url && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { ...cache.report, cached: true };
  }

  const fetchedAt = new Date(now).toISOString();
  try {
    const fetchImpl = input.fetchImpl ?? fetch;
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`模型源返回 HTTP ${response.status}`);
    const report: ModelsReport = {
      source: url,
      fetchedAt,
      cached: false,
      models: normalizeModels(await response.json()),
    };
    cache = { url, fetchedAt: now, report };
    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cache && cache.url === url) return { ...cache.report, cached: true, stale: true, error: message };
    return { source: url, fetchedAt, cached: false, error: message, models: [] };
  }
}

/** Test hook: drop the in-memory cache. */
export function clearModelCache(): void {
  cache = null;
}
