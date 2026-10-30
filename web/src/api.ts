import type {
  ConfigReport,
  HealthResponse,
  HookActionRequest,
  HookActionResponse,
  HookMatrixReport,
  MatrixResponse,
  McpActionRequest,
  McpActionResponse,
  McpMatrixReport,
  ModelsReport,
  OpenResponse,
  PromptActionReport,
  PromptActionRequest,
  PromptsReport,
  PromptSaveReport,
  PromptSourceContent,
  RestoreResponse,
  SettingsCatalog,
  SettingsReport,
  SettingsSaveRequest,
  SettingsSaveResult,
  SkillActionRequest,
  SkillActionResponse,
  SnapshotManifest,
} from '../../shared/types.ts';

export type { HealthResponse, OpenResponse } from '../../shared/types.ts';

const REQUEST_TIMEOUT_MS = 15_000;

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
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
      throw new Error(`请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒内没有响应），请确认后台服务仍在运行`);
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
  settingsCatalog: (signal?: AbortSignal) =>
    request<SettingsCatalog>('/api/settings/catalog', { signal }),
  settings: (signal?: AbortSignal) => request<SettingsReport>('/api/settings', { signal }),
  saveSettings: (body: SettingsSaveRequest) =>
    request<SettingsSaveResult>('/api/settings/save', post(body)),
  models: (refresh = false, signal?: AbortSignal, url?: string) => {
    const params = new URLSearchParams();
    if (refresh) params.set('refresh', '1');
    if (url && url.trim() !== '') params.set('url', url.trim());
    const qs = params.toString();
    return request<ModelsReport>(`/api/models${qs ? `?${qs}` : ''}`, { signal });
  },
};
