import type {
  ConfigReport,
  MatrixResponse,
  PromptActionReport,
  PromptActionRequest,
  PromptsReport,
  RestoreResponse,
  SkillActionRequest,
  SkillActionResponse,
  SnapshotManifest,
} from '../../shared/types.ts';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `请求失败 ${response.status}`);
  return body as T;
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export const api = {
  matrix: () => request<MatrixResponse>('/api/matrix'),
  skill: (body: SkillActionRequest) => request<SkillActionResponse>('/api/skills', post(body)),
  prompts: () => request<PromptsReport>('/api/prompts'),
  promptAction: (body: PromptActionRequest) => request<PromptActionReport>('/api/prompts', post(body)),
  config: () => request<ConfigReport>('/api/config'),
  snapshots: () => request<SnapshotManifest[]>('/api/snapshots'),
  restore: (id: string) => request<RestoreResponse>('/api/snapshots/restore', post({ id })),
  open: (path: string) => request<{ opened: string }>('/api/open', post({ path })),
};
