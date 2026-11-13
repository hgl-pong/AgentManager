import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { AppError } from '../shared/types.ts';
import type {
  AgentSpec,
  ModelApplyRequest,
  ModelApplyResponse,
  ModelApplyAgentSummary,
  ModelInfo,
  ModelTargetAgent,
  ModelTargetsReport,
  SettingsFileDescriptor,
  SettingsFileState,
} from '../shared/types.ts';
import { activeProviderInfo, getProviderModels } from './providers.ts';
import { readSettings, saveSettings, writeAtomically } from './settings.ts';
import { createSnapshot, markSnapshotFailed } from './snapshot.ts';

type JsonObject = Record<string, unknown>;

const PI_PROVIDER_ID = 'agentmanager';
const CODEX_PROVIDER_ID = 'agentmanager';
const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRoot(value: unknown, path: string): JsonObject {
  if (!isRecord(value)) throw new AppError(409, `${path} 的根不是对象，不能写入模型配置`);
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileById(files: SettingsFileDescriptor[], id: string): SettingsFileDescriptor {
  const file = files.find((entry) => entry.id === id);
  if (!file) throw new AppError(500, `设置文件未注册：${id}`);
  return file;
}

function stateById(states: SettingsFileState[], id: string): SettingsFileState {
  const state = states.find((entry) => entry.id === id);
  if (!state) throw new AppError(500, `读不到设置文件：${id}`);
  return state;
}

/** The user-level files each agent's model package touches, for the confirmation dialog. */
export function modelTargets(input: {
  files: SettingsFileDescriptor[];
  piModelsPath: string;
  agents: AgentSpec[];
}): ModelTargetsReport {
  const list: ModelTargetAgent[] = [];
  for (const agent of input.agents) {
    if (agent.key === 'claude') {
      const file = fileById(input.files, 'claude-settings');
      list.push({
        key: agent.key,
        label: agent.label,
        detected: existsSync(file.path),
        files: [{ label: file.role || basename(file.path), path: file.path }],
      });
      continue;
    }
    if (agent.key === 'codex') {
      const file = fileById(input.files, 'codex-config');
      list.push({
        key: agent.key,
        label: agent.label,
        detected: existsSync(file.path),
        files: [{ label: file.role || basename(file.path), path: file.path }],
      });
      continue;
    }
    if (agent.key === 'pi') {
      const file = fileById(input.files, 'pi-settings');
      list.push({
        key: agent.key,
        label: agent.label,
        detected: existsSync(file.path) || existsSync(input.piModelsPath),
        files: [
          { label: 'models.json', path: input.piModelsPath },
          { label: file.role || basename(file.path), path: file.path },
        ],
      });
    }
  }
  return { agents: list };
}

/** Saves one registered settings file after merging the model package into its current data. */
function saveMerged(
  files: SettingsFileDescriptor[],
  snapshotRoot: string,
  fileId: string,
  merge: (root: JsonObject) => JsonObject,
): { path: string; snapshotId: string } {
  const report = readSettings(files);
  const states = report.agents.flatMap((agent) => agent.files);
  const state = stateById(states, fileId);
  if (state.parseError) {
    throw new AppError(409, `${state.path} 无法解析（${state.parseError}），先修复后再应用模型`);
  }
  const root = state.data === undefined ? {} : assertRoot(state.data, state.path);
  const next = merge(root);
  const result = saveSettings({
    files,
    snapshotRoot,
    request: { fileId, etag: state.etag, data: next },
  });
  return { path: state.path, snapshotId: result.snapshotId };
}

function claudeBaseUrl(baseUrl: string): string {
  // Claude Code's SDK appends /v1/messages; a provider base that ends in /v1 would duplicate it.
  return baseUrl.replace(/\/v1$/i, '');
}

function applyClaude(
  files: SettingsFileDescriptor[],
  snapshotRoot: string,
  provider: { baseUrl: string; apiKey: string },
  model: ModelInfo,
): ModelApplyAgentSummary {
  const writes = [
    'model',
    'env.ANTHROPIC_BASE_URL',
    'env.ANTHROPIC_AUTH_TOKEN',
    'env.ANTHROPIC_MODEL',
    'env.ANTHROPIC_DEFAULT_OPUS_MODEL',
    'env.ANTHROPIC_DEFAULT_SONNET_MODEL',
    'env.ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'env.ANTHROPIC_DEFAULT_FABLE_MODEL',
    'env.CLAUDE_CODE_SUBAGENT_MODEL',
    'env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
  ];
  if (model.effort) writes.push('env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT');
  if (model.contextWindow && model.contextWindow > 0) writes.push('env.CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  const saved = saveMerged(files, snapshotRoot, 'claude-settings', (root) => {
    const env = isRecord(root.env) ? { ...root.env } : {};
    env.ANTHROPIC_BASE_URL = claudeBaseUrl(provider.baseUrl);
    env.ANTHROPIC_AUTH_TOKEN = provider.apiKey;
    env.ANTHROPIC_MODEL = model.id;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model.id;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model.id;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model.id;
    env.ANTHROPIC_DEFAULT_FABLE_MODEL = model.id;
    env.CLAUDE_CODE_SUBAGENT_MODEL = model.id;
    env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1';
    if (model.effort) env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1';
    if (model.contextWindow && model.contextWindow > 0) {
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(Math.round(model.contextWindow));
    }
    return { ...root, model: model.id, env };
  });
  return {
    key: 'claude',
    label: 'Claude Code',
    files: [saved.path],
    snapshotIds: [saved.snapshotId],
    writes,
  };
}

function applyCodex(
  files: SettingsFileDescriptor[],
  snapshotRoot: string,
  provider: { baseUrl: string; apiKey: string; host: string },
  model: ModelInfo,
): ModelApplyAgentSummary {
  const writes = [
    'model',
    'model_provider',
    `model_providers.${CODEX_PROVIDER_ID}`,
    'model_context_window',
  ];
  const saved = saveMerged(files, snapshotRoot, 'codex-config', (root) => {
    const providers = isRecord(root.model_providers) ? { ...root.model_providers } : {};
    providers[CODEX_PROVIDER_ID] = {
      name: provider.host,
      base_url: provider.baseUrl,
      wire_api: 'responses',
      requires_openai_auth: true,
      experimental_bearer_token: provider.apiKey,
    };
    const next: JsonObject = {
      ...root,
      model: model.id,
      model_provider: CODEX_PROVIDER_ID,
      model_providers: providers,
    };
    if (model.contextWindow && model.contextWindow > 0) {
      next.model_context_window = Math.round(model.contextWindow);
    } else {
      delete next.model_context_window;
    }
    return next;
  });
  return {
    key: 'codex',
    label: 'Codex',
    files: [saved.path],
    snapshotIds: [saved.snapshotId],
    writes,
  };
}

function piInput(model: ModelInfo): string[] {
  const input = ['text'];
  if (model.imageInput) input.push('image');
  if (model.pdfInput) input.push('pdf');
  return input;
}

function piThinkingLevels(model: ModelInfo): Record<string, string | null> | null {
  const levels = model.effortLevels ?? [];
  if (levels.length === 0) return null;
  return Object.fromEntries(
    PI_THINKING_LEVELS.map((level) => [level, levels.includes(level) ? level : null]),
  );
}

function piModel(model: ModelInfo): JsonObject {
  const thinking = piThinkingLevels(model);
  return {
    id: model.id,
    name: model.name !== '' ? model.name : model.id,
    reasoning: Boolean(model.thinking || model.effort),
    input: piInput(model),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(model.contextWindow && model.contextWindow > 0
      ? { contextWindow: Math.round(model.contextWindow) }
      : {}),
    ...(model.maxOutputTokens && model.maxOutputTokens > 0
      ? { maxTokens: Math.round(model.maxOutputTokens) }
      : {}),
    ...(thinking ? { thinkingLevelMap: thinking } : {}),
  };
}

function writePiModels(
  path: string,
  snapshotRoot: string,
  models: ModelInfo[],
  provider: { baseUrl: string; apiKey: string; host: string },
): string {
  let root: JsonObject = {};
  if (existsSync(path)) {
    try {
      root = assertRoot(JSON.parse(readFileSync(path, 'utf8')), path);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(409, `${path} 无法解析（${errorText(error)}），先修复后再应用模型`);
    }
  }
  const providers = isRecord(root.providers) ? { ...root.providers } : {};
  providers[PI_PROVIDER_ID] = {
    name: provider.host,
    baseUrl: provider.baseUrl,
    api: 'openai-completions',
    apiKey: provider.apiKey,
    authHeader: true,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: models.some((model) => model.effort),
      supportsUsageInStreaming: true,
      supportsStrictMode: false,
      maxTokensField: 'max_tokens',
    },
    models: models.map(piModel),
  };
  const next = { ...root, providers };
  const existed = existsSync(path);
  const snapshot = createSnapshot(
    snapshotRoot,
    `apply model ${provider.host} to pi models`,
    existed ? [path] : [],
    existed ? [] : [path],
  );
  try {
    writeAtomically(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    markSnapshotFailed(snapshotRoot, snapshot.id);
    throw new AppError(500, `写入 ${path} 失败：${errorText(error)}`);
  }
  return snapshot.id;
}

function applyPi(
  files: SettingsFileDescriptor[],
  snapshotRoot: string,
  piModelsPath: string,
  provider: { baseUrl: string; apiKey: string; host: string },
  models: ModelInfo[],
  selected: ModelInfo,
): ModelApplyAgentSummary {
  const modelsSnapshot = writePiModels(piModelsPath, snapshotRoot, models, provider);
  const settings = saveMerged(files, snapshotRoot, 'pi-settings', (root) => ({
    ...root,
    defaultProvider: PI_PROVIDER_ID,
    defaultModel: selected.id,
  }));
  return {
    key: 'pi',
    label: 'pi',
    files: [piModelsPath, settings.path],
    snapshotIds: [modelsSnapshot, settings.snapshotId],
    writes: ['providers.agentmanager.models', 'defaultProvider', 'defaultModel'],
  };
}

/**
 * Writes the active provider's full package into the selected agents. `model_catalog_json`
 * on Codex is deliberately preserved: it is maintained elsewhere.
 */
export async function applyModelPackage(input: {
  files: SettingsFileDescriptor[];
  agents: AgentSpec[];
  providerSource: string;
  piModelsPath: string;
  snapshotRoot: string;
  request: ModelApplyRequest;
}): Promise<ModelApplyResponse> {
  const request = input.request;
  if (!request || typeof request !== 'object') throw new AppError(400, '请求体必须是对象');
  const modelId = typeof request.modelId === 'string' ? request.modelId.trim() : '';
  if (modelId === '') throw new AppError(400, '缺少 modelId');
  const requested = Array.isArray(request.agents)
    ? [...new Set(request.agents.filter((key): key is string => typeof key === 'string'))]
    : [];
  if (requested.length === 0) throw new AppError(400, '至少选择一个 agent');

  const known = new Set(input.agents.map((agent) => agent.key));
  const unknown = requested.filter((key) => !known.has(key));
  if (unknown.length > 0) throw new AppError(400, `未知的 agent：${unknown.join('、')}`);

  const provider = activeProviderInfo(input.providerSource);
  if (!provider) throw new AppError(400, '还没有配置 active provider');
  const report = await getProviderModels(input.providerSource, false);
  if (report.models.length === 0) {
    throw new AppError(
      502,
      `读取 provider 模型失败：${report.error ?? 'Provider 没有返回模型'}`,
    );
  }
  const model = report.models.find((entry) => entry.id === modelId);
  if (!model) throw new AppError(404, `provider 当前列表里没有 ${modelId}`);

  const summaries: ModelApplyAgentSummary[] = [];
  for (const agent of input.agents) {
    if (!requested.includes(agent.key)) continue;
    if (agent.key === 'claude') {
      summaries.push(applyClaude(input.files, input.snapshotRoot, provider, model));
    } else if (agent.key === 'codex') {
      summaries.push(applyCodex(input.files, input.snapshotRoot, provider, model));
    } else if (agent.key === 'pi') {
      summaries.push(
        applyPi(
          input.files,
          input.snapshotRoot,
          input.piModelsPath,
          provider,
          report.models,
          model,
        ),
      );
    }
  }

  const labels = summaries.map((summary) => summary.label).join('、');
  return {
    message: `已把 ${model.id} 的完整配置写入 ${labels}`,
    model: { id: model.id, name: model.name, providerHost: provider.host },
    agents: summaries,
    snapshotIds: summaries.flatMap((summary) => summary.snapshotIds),
  };
}
