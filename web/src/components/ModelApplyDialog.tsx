import { useEffect, useId, useRef, useState } from 'react';

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

/**
 * The model is a package, not a string: each agent gets its own provider fields. This dialog
 * names the files and the sections before the server writes them, and keeps the key out of the copy.
 */
export function ModelApplyDialog({
  model,
  provider,
  targets,
  onClose,
  onApplied,
}: {
  model: ModelInfo;
  provider: ProviderSummary;
  targets: ModelTargetAgent[];
  onClose: () => void;
  onApplied: (result: ModelApplyResponse) => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const applyRef = useRef<HTMLButtonElement | null>(null);
  const titleId = `${useId()}-model-apply-title`;
  const [selected, setSelected] = useState<string[]>(() => {
    const detected = targets.filter((target) => target.detected).map((target) => target.key);
    return detected.length > 0 ? detected : targets.map((target) => target.key);
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  function toggle(key: string, checked: boolean) {
    setSelected((current) =>
      checked ? [...new Set([...current, key])] : current.filter((entry) => entry !== key),
    );
  }

  async function apply() {
    if (busy || selected.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.applyModel({ modelId: model.id, agents: selected });
      onApplied(result);
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      className="confirm-dialog model-apply-dialog"
      data-size="md"
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
      <h2 id={titleId}>
        应用模型 <code>{model.id}</code>
      </h2>
      <div className="confirm-dialog-body model-apply-body">
        <p>
          Provider <strong>{provider.host}</strong>
          <br />
          <code>{provider.baseUrl}</code>
        </p>
        <p className="warning">
          会把 provider 的 base URL、API key 与模型信息写入选中 agent 的配置文件；写入前自动建快照。
          API key 不会显示在页面上。
        </p>

        <div className="model-apply-agents">
          {targets.map((target) => (
            <label
              key={target.key}
              className={
                selected.includes(target.key) ? 'model-apply-agent is-selected' : 'model-apply-agent'
              }
            >
              <input
                type="checkbox"
                checked={selected.includes(target.key)}
                disabled={busy}
                onChange={(event) => toggle(target.key, event.target.checked)}
              />
              <span className="model-apply-copy">
                <span className="model-apply-title">
                  <strong>{target.label}</strong>
                  {!target.detected && <span className="tag">未检测到</span>}
                </span>
                <span className="model-apply-write">{WRITE_SUMMARY[target.key]}</span>
                {target.files.map((file) => (
                  <code key={file.path} className="model-apply-path" title={file.path}>
                    {file.path}
                  </code>
                ))}
              </span>
            </label>
          ))}
        </div>

        <p className="hint">
          Claude Code 写入 env 包，base URL 会去掉末尾的 <code>/v1</code>（SDK 会再拼接口路径）；
          Codex 写入 model_provider / model_providers.agentmanager 与 model；pi 写入 models.json
          的完整模型清单。Codex 的 <code>model_catalog_json</code> 保持不变。
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
          disabled={busy || selected.length === 0}
          onClick={() => void apply()}
        >
          {busy ? '写入中…' : '写入选中 agent'}
        </button>
      </div>
    </dialog>
  );
}
