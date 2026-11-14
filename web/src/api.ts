import type {
  BuiltinInstallRequest,
  BuiltinInstallResponse,
  BuiltinSkillReport,
  CacheActionRequest,
  CacheActionResponse,
  CacheReport,
  ConfigReport,
  HealthResponse,
  HookActionRequest,
  HookActionResponse,
  HookMatrixReport,
  MatrixResponse,
  McpActionRequest,
  ModelApplyRequest,
  ModelApplyResponse,
  ModelTargetsReport,
  McpActionResponse,
  McpMatrixReport,
  OpenResponse,
  PromptActionReport,
  PromptActionRequest,
  PromptsReport,
  PromptSaveReport,
  PromptSourceContent,
  ProviderActionRequest,
  ProviderModelsReport,
  ProviderMutationResponse,
  ProviderSaveRequest,
  ProvidersReport,
  RestoreResponse,
  SettingsCatalog,
  SettingsReport,
  SettingsSaveRequest,
  SettingsSaveResult,
  SkillActionRequest,
  SkillActionResponse,
  SnapshotManifest,
  StoreInstallRequest,
  StoreInstallResponse,
  StoreKind,
  StoreMcpInstallRequest,
  StoreMcpInstallResponse,
  StoreReport,
  StoreSkillDetail,
} from '../../shared/types.ts';

export type { HealthResponse, OpenResponse } from '../../shared/types.ts';

const REQUEST_TIMEOUT_MS = 15_000;
/** The registry is a remote service with its own retries, so store calls wait longer than local ones. */
const STORE_TIMEOUT_MS = 60_000;

/** An HTTP failure that keeps the status code, so 409 conflicts can be handled explicitly. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError';
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const external = init?.signal;
  const signal = external ? AbortSignal.any([external, timeout]) : timeout;

  try {
    const response = await fetch(path, { ...init, signal });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new HttpError(
        response.status,
        typeof body.error === 'string' ? body.error : `请求失败 ${response.status}`,
      );
    }
    return body as T;
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === 'TimeoutError') {
      throw new Error(`请求超时（${timeoutMs / 1000} 秒内没有响应），请确认后台服务仍在运行`);
    }
    throw reason;
  }
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export const api = {
  matrix: (signal?: AbortSignal) => request<MatrixResponse>('/api/matrix', { signal }),
  skill: (body: SkillActionRequest) => request<SkillActionResponse>('/api/skills', post(body)),
  prompts: (signal?: AbortSignal) => request<PromptsReport>('/api/prompts', { signal }),
  promptTemplate: (signal?: AbortSignal) =>
    request<{ content: string }>('/api/prompts/template', { signal }),
  promptAction: (body: PromptActionRequest) => request<PromptActionReport>('/api/prompts', post(body)),
  promptContent: (signal?: AbortSignal) => request<PromptSourceContent>('/api/prompts/content', { signal }),
  savePrompt: (content: string, etag: string) =>
    request<PromptSaveReport>('/api/prompts/content', post({ content, etag })),
  config: (signal?: AbortSignal) => request<ConfigReport>('/api/config', { signal }),
  mcp: (signal?: AbortSignal) => request<McpMatrixReport>('/api/mcp', { signal }),
  mcpAction: (body: McpActionRequest) => request<McpActionResponse>('/api/mcp', post(body)),
  hooks: (signal?: AbortSignal) => request<HookMatrixReport>('/api/hooks', { signal }),
  hookAction: (body: HookActionRequest) => request<HookActionResponse>('/api/hooks', post(body)),
  snapshots: (signal?: AbortSignal) => request<SnapshotManifest[]>('/api/snapshots', { signal }),
  restore: (id: string) => request<RestoreResponse>('/api/snapshots/restore', post({ id })),
  open: (path: string) => request<OpenResponse>('/api/open', post({ path })),
  health: (signal?: AbortSignal) => request<HealthResponse>('/api/health', { signal }),
  quit: () => request<{ stopping: boolean }>('/api/app/quit', post({})),
  cache: (signal?: AbortSignal) => request<CacheReport>('/api/cache', { signal }),
  cacheAction: (body: CacheActionRequest) => request<CacheActionResponse>('/api/cache', post(body)),
  store: (
    query = '',
    options: {
      kind?: StoreKind;
      page?: number;
      cursor?: string;
      limit?: number;
      /** Whole-catalog filters; the registry narrows the result before it pages it. */
      category?: string;
      risk?: string;
      hasScripts?: boolean;
      refresh?: boolean;
      signal?: AbortSignal;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (query.trim() !== '') params.set('q', query.trim());
    if (options.kind === 'mcp') params.set('kind', 'mcp');
    if (options.page !== undefined) params.set('page', String(options.page));
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.category) params.set('category', options.category);
    if (options.risk) params.set('risk', options.risk);
    if (options.hasScripts) params.set('hasScripts', '1');
    if (options.refresh) params.set('refresh', '1');
    const qs = params.toString();
    return request<StoreReport>(`/api/store${qs ? `?${qs}` : ''}`, { signal: options.signal }, STORE_TIMEOUT_MS);
  },
  storeSkill: (slug: string, signal?: AbortSignal) =>
    request<StoreSkillDetail>(
      `/api/store/skill?slug=${encodeURIComponent(slug)}`,
      { signal },
      STORE_TIMEOUT_MS,
    ),
  installStoreSkill: (body: StoreInstallRequest) =>
    request<StoreInstallResponse>('/api/store/install', post(body), STORE_TIMEOUT_MS),
  builtins: (signal?: AbortSignal) => request<BuiltinSkillReport>('/api/builtins', { signal }),
  installBuiltin: (body: BuiltinInstallRequest) =>
    request<BuiltinInstallResponse>('/api/builtins/install', post(body), STORE_TIMEOUT_MS),
  installStoreMcp: (body: StoreMcpInstallRequest) =>
    request<StoreMcpInstallResponse>('/api/store/install-mcp', post(body), STORE_TIMEOUT_MS),
  settingsCatalog: (signal?: AbortSignal) =>
    request<SettingsCatalog>('/api/settings/catalog', { signal }),
  settings: (signal?: AbortSignal) => request<SettingsReport>('/api/settings', { signal }),
  saveSettings: (body: SettingsSaveRequest) =>
    request<SettingsSaveResult>('/api/settings/save', post(body)),
  providers: (signal?: AbortSignal) => request<ProvidersReport>('/api/providers', { signal }),
  saveProvider: (body: ProviderSaveRequest) =>
    request<ProviderMutationResponse>('/api/providers/save', post(body)),
  activateProvider: (body: ProviderActionRequest) =>
    request<ProviderMutationResponse>('/api/providers/activate', post(body)),
  removeProvider: (body: ProviderActionRequest) =>
    request<ProviderMutationResponse>('/api/providers/remove', post(body)),
  providerModels: (refresh = false, signal?: AbortSignal) => {
    const qs = refresh ? '?refresh=1' : '';
    return request<ProviderModelsReport>(`/api/providers/models${qs}`, { signal });
  },
  modelTargets: (signal?: AbortSignal) => request<ModelTargetsReport>('/api/model/targets', { signal }),
  applyModel: (body: ModelApplyRequest) =>
    request<ModelApplyResponse>('/api/model/apply', post(body)),
};
