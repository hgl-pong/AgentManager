import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { api, errorMessage } from '../api.ts';
import type {
  ModelApplyResponse,
  ModelInfo,
  ModelTargetAgent,
  ProviderSummary,
} from '../../../shared/types.ts';
import { trackConfirmOpen } from '../lib/confirm.tsx';

const WRITE_SUMMARY: Record<string, string> = {
  claude: 'env.ANTHROPIC_BASE_URL · AUTH_TOKEN · MODEL + 默认模型 · context',
  codex: 'model_provider · model_providers.agentmanager · model · context window',
  pi: 'models.json 的 provider（全部模型）· defaultProvider / defaultModel',
};

function formatTokens(value: number | undefined): string {
  if (!value || value <= 0) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

function claudeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1$/i, '');
}

/** Builds a human-readable preview of what each agent receives, with the key masked. */
function previewClaude(model: ModelInfo, baseUrl: string): string {
  const lines = [
    `model = "${model.id}"`,
    `env.ANTHROPIC_BASE_URL = "${claudeBaseUrl(baseUrl)}"`,
    `env.ANTHROPIC_AUTH_TOKEN = "••••••••"`,
    `env.ANTHROPIC_MODEL = "${model.id}"`,
    `env.ANTHROPIC_DEFAULT_OPUS_MODEL = "${model.id}"`,
    `env.ANTHROPIC_DEFAULT_SONNET_MODEL = "${model.id}"`,
    `env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "${model.id}"`,
    `env.ANTHROPIC_DEFAULT_FABLE_MODEL = "${model.id}"`,
    `env.CLAUDE_CODE_SUBAGENT_MODEL = "${model.id}"`,
    `env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1"`,
  ];
  if (model.effort) lines.push(`env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = "1"`);
  if (model.contextWindow && model.contextWindow > 0)
    lines.push(`env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "${Math.round(model.contextWindow)}"`);
  return lines.join('\n');
}

function previewCodex(model: ModelInfo, baseUrl: string, host: string): string {
  const lines = [
    `model = "${model.id}"`,
    `model_provider = "agentmanager"`,
    ...(model.contextWindow && model.contextWindow > 0
      ? [`model_context_window = ${Math.round(model.contextWindow)}`]
      : []),
    '',
    `[model_providers.agentmanager]`,
    `name = "${host}"`,
    `base_url = "${baseUrl}"`,
    `wire_api = "responses"`,
    `requires_openai_auth = true`,
    `experimental_bearer_token = "••••••••"`,
  ];
  return lines.join('\n');
}

function previewPi(model: ModelInfo, modelCount: number, baseUrl: string, host: string): string {
  const caps: string[] = [];
  if (model.thinking) caps.push('thinking');
  if (model.imageInput) caps.push('image');
  if (model.pdfInput) caps.push('pdf');
  const levels = model.effortLevels ?? [];
  const lines = [
    `models.json:`,
    `  providers.agentmanager = {`,
    `    name: "${host}", baseUrl: "${baseUrl}",`,
    `    api: "openai-completions", apiKey: "••••••••",`,
    `    models: [ ${modelCount} 个模型 ],`,
    `  }`,
    '',
    `settings.json:`,
    `  defaultProvider = "agentmanager"`,
    `  defaultModel = "${model.id}"`,
    ...(caps.length > 0 ? [`  (${caps.join(' · ')})`] : []),
    ...(levels.length > 0 ? [`  thinkingLevels: ${levels.join(', ')}`] : []),
  ];
  return lines.join('\n');
}

/**
 * Import every model into the selected agents, with a model picker and a live preview of the
 * exact config each agent will receive. The key is masked in the preview.
 */
export function ModelImportDialog({
  models,
  provider,
  targets,
  onClose,
  onApplied,
}: {
  models: ModelInfo[];
  provider: ProviderSummary;
  targets: ModelTargetAgent[];
  onClose: () => void;
  onApplied: (result: ModelApplyResponse) => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const applyRef = useRef<HTMLButtonElement | null>(null);
  const titleId = `${useId()}-model-import-title`;
  const [defaultModelId, setDefaultModelId] = useState<string>(() => models[0]?.id ?? '');
  const [modelQuery, setModelQuery] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<string[]>(() => {
    const detected = targets.filter((target) => target.detected).map((target) => target.key);
    return detected.length > 0 ? detected : targets.map((target) => target.key);
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultModel = useMemo(
    () => models.find((model) => model.id === defaultModelId) ?? models[0],
    [models, defaultModelId],
  );

  const filteredModels = useMemo(() => {
    const needle = modelQuery.trim().toLowerCase();
    if (needle === '') return models;
    return models.filter((model) =>
      `${model.id} ${model.name} ${model.group}`.toLowerCase().includes(needle),
    );
  }, [models, modelQuery]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    applyRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  useEffect(() => trackConfirmOpen(), []);

  function toggleAgent(key: string, checked: boolean) {
    setSelectedAgents((current) =>
      checked ? [...new Set([...current, key])] : current.filter((entry) => entry !== key),
    );
  }

  async function apply() {
    if (busy || !defaultModel || selectedAgents.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.applyModel({ modelId: defaultModel.id, agents: selectedAgents });
      onApplied(result);
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false);
    }
  }

  const activeTargets = targets.filter((target) => selectedAgents.includes(target.key));

  return (
    <dialog
      ref={ref}
      className="confirm-dialog model-import-dialog"
      data-size="lg"
      tabIndex={-1}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current && !busy) onClose();
      }}
    >
      <h2 id={titleId}>导入全部模型到 agent</h2>
      <div className="confirm-dialog-body model-import-body">
        <p>
          Provider <strong>{provider.host}</strong>
          <br />
          <code>{provider.baseUrl}</code>
          {' · '}
          {models.length} 个模型
        </p>

        <div className="model-import-grid">
          <div className="model-import-picker">
            <label className="model-import-field-label" htmlFor="model-import-search">
              选择默认模型
            </label>
            <input
              id="model-import-search"
              className="control model-import-search"
              type="search"
              value={modelQuery}
              placeholder="筛选模型…"
              spellCheck={false}
              onChange={(event) => setModelQuery(event.target.value)}
            />
            <div className="model-import-list" role="radiogroup" aria-label="默认模型">
              {filteredModels.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  role="radio"
                  aria-checked={model.id === defaultModelId}
                  className={
                    model.id === defaultModelId
                      ? 'model-import-option is-active'
                      : 'model-import-option'
                  }
                  disabled={busy}
                  onClick={() => setDefaultModelId(model.id)}
                >
                  <code>{model.id}</code>
                  {model.name !== model.id && <span className="model-import-name">{model.name}</span>}
                  <span className="model-import-meta">
                    {formatTokens(model.contextWindow)}
                    {model.thinking && ' · thinking'}
                    {model.imageInput && ' · 图片'}
                  </span>
                </button>
              ))}
              {filteredModels.length === 0 && (
                <p className="muted">没有匹配的模型。</p>
              )}
            </div>
          </div>

          <div className="model-import-side">
            <div className="model-import-agents">
              <span className="model-import-field-label">写入目标</span>
              {targets.map((target) => (
                <label
                  key={target.key}
                  className={
                    selectedAgents.includes(target.key)
                      ? 'model-apply-agent is-selected'
                      : 'model-apply-agent'
                  }
                >
                  <input
                    type="checkbox"
                    checked={selectedAgents.includes(target.key)}
                    disabled={busy}
                    onChange={(event) => toggleAgent(target.key, event.target.checked)}
                  />
                  <span className="model-apply-copy">
                    <span className="model-apply-title">
                      <strong>{target.label}</strong>
                      {!target.detected && <span className="tag">未检测到</span>}
                    </span>
                    <span className="model-apply-write">{WRITE_SUMMARY[target.key]}</span>
                  </span>
                </label>
              ))}
            </div>

            {defaultModel && (
              <div className="model-import-preview">
                <span className="model-import-field-label">预览写入内容</span>
                {activeTargets.map((target) => (
                  <details key={target.key} className="model-import-preview-agent" open>
                    <summary>
                      <strong>{target.label}</strong>
                      <code>{target.files[0]?.path}</code>
                    </summary>
                    <pre className="model-import-code">
                      {target.key === 'claude'
                        ? previewClaude(defaultModel, provider.baseUrl)
                        : target.key === 'codex'
                          ? previewCodex(defaultModel, provider.baseUrl, provider.host)
                          : previewPi(defaultModel, models.length, provider.baseUrl, provider.host)}
                    </pre>
                  </details>
                ))}
              </div>
            )}
          </div>
        </div>

        <p className="hint">
          pi 的 models.json 会包含全部 {models.length} 个模型；Claude Code 和 Codex 的模型清单由各自的
          discovery 从 provider 读取。Codex 的 <code>model_catalog_json</code> 保持不变。
        </p>
        {error && <p className="error">{error}</p>}
      </div>
      <div className="confirm-dialog-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button
          ref={applyRef}
          type="button"
          className="primary"
          disabled={busy || !defaultModel || selectedAgents.length === 0}
          onClick={() => void apply()}
        >
          {busy ? '写入中…' : `写入 ${selectedAgents.length} 个 agent`}
        </button>
      </div>
    </dialog>
  );
}
