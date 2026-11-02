import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorMessage } from '../api.ts';
import { trackConfirmOpen } from '../lib/confirm.tsx';
import { fill, pick, STORE_TEXT } from '../lib/store-i18n.ts';
import type { StoreLang } from '../lib/store-i18n.ts';
import type {
  McpServerDefinition,
  StoreMcpInstallResponse,
  StoreMcpOption,
  StoreMcpServer,
  StoreMcpVariable,
} from '../../../shared/types.ts';

interface AgentOption {
  key: string;
  label: string;
  detected: boolean;
}

function variableKey(variable: StoreMcpVariable): string {
  return `${variable.target}:${variable.name}`;
}

/** Replaces one `{token}` wherever the definition carries it (a header value such as `Bearer {key}`). */
function applyTemplate(server: McpServerDefinition, token: string, value: string): void {
  const swap = (text: string) => text.replaceAll(`{${token}}`, value);
  if (server.command !== undefined) server.command = swap(server.command);
  if (server.cwd !== undefined) server.cwd = swap(server.cwd);
  if (server.url !== undefined) server.url = swap(server.url);
  if (server.args !== undefined) server.args = server.args.map(swap);
  if (server.env !== undefined) {
    server.env = Object.fromEntries(
      Object.entries(server.env).map(([key, text]) => [key, swap(text)]),
    );
  }
  if (server.headers !== undefined) {
    server.headers = Object.fromEntries(
      Object.entries(server.headers).map(([key, text]) => [key, swap(text)]),
    );
  }
}

/** Completes the registry option with the values the dialog collected. */
function buildDefinition(option: StoreMcpOption, values: Record<string, string>): McpServerDefinition {
  const server: McpServerDefinition = { ...option.server };
  for (const variable of option.variables) {
    const value = values[variableKey(variable)] ?? '';
    if (variable.target === 'template') {
      applyTemplate(server, variable.name, value);
    } else if (variable.target === 'url') {
      if (server.url !== undefined) server.url = server.url.replaceAll(`{${variable.name}}`, value);
    } else if (variable.target === 'env') {
      server.env = { ...server.env, [variable.name]: value };
    } else {
      server.headers = { ...server.headers, [variable.name]: value };
    }
  }
  return server;
}

/** What a stdio option launches, or the endpoint an http/sse option connects to. */
function previewText(option: StoreMcpOption): string {
  if (option.server.transport !== 'stdio') return option.server.url ?? '';
  return [option.server.command ?? '', ...(option.server.args ?? [])].filter(Boolean).join(' ');
}

/**
 * Installing from the registry often needs values only the user has (API keys, a workspace slug),
 * so the install is a form rather than a yes/no question. It owns its request: a failure stays
 * inside the dialog and the user can fix the inputs and retry.
 */
export function StoreMcpInstallDialog({
  item,
  lang,
  agents,
  targetKeys,
  onClose,
  onInstalled,
}: {
  item: StoreMcpServer;
  lang: StoreLang;
  agents: AgentOption[];
  targetKeys: string[];
  onClose: () => void;
  onInstalled: (result: StoreMcpInstallResponse) => void;
}) {
  const [optionId, setOptionId] = useState(item.options[0]?.id ?? '');
  const [name, setName] = useState(item.installName);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDialogElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const titleId = `${useId()}-mcp-install-title`;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    nameRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  // Global shortcuts must stand down while the form is modal.
  useEffect(() => trackConfirmOpen(), []);

  const option = item.options.find((candidate) => candidate.id === optionId) ?? item.options[0];
  if (option === undefined) return null;
  // Function declarations are hoisted, so the guard above does not narrow `option` inside them.
  const chosen = option;

  const labels = agents.filter((agent) => targetKeys.includes(agent.key)).map((agent) => agent.label);
  const missing = option.variables.filter(
    (variable) => (values[variableKey(variable)] ?? '').trim() === '',
  );
  const canSubmit = !busy && name.trim() !== '' && missing.length === 0;

  function chooseOption(nextId: string) {
    setOptionId(nextId);
    // Values belong to the previous option's variables; reusing them would mix unrelated keys.
    setValues({});
    setError(null);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    void api
      .installStoreMcp({
        name: name.trim(),
        server: buildDefinition(chosen, values),
        agents: targetKeys,
      })
      .then((result) => onInstalled(result))
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setBusy(false));
  }

  return (
    <dialog
      ref={ref}
      className="confirm-dialog store-mcp-dialog"
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
      <form onSubmit={submit} noValidate>
        <h2 id={titleId}>{fill(pick(lang, { zh: '安装 %s', en: 'Install %s' }), item.name)}</h2>
        <div className="confirm-dialog-body store-mcp-body">
          <p className="store-mcp-id">
            <code>{item.id}</code>
            {item.version ? ` · v${item.version}` : ''}
          </p>

          <section className="store-mcp-section">
            <h3 className="store-mcp-section-title">{pick(lang, STORE_TEXT.mcpOption)}</h3>
            <div
              className="store-mcp-options"
              role="radiogroup"
              aria-label={pick(lang, STORE_TEXT.mcpOption)}
            >
              {item.options.map((candidate) => {
                const selected = candidate.id === optionId;
                return (
                  <label
                    className={selected ? 'store-mcp-option is-selected' : 'store-mcp-option'}
                    key={candidate.id}
                  >
                    <input
                      type="radio"
                      name="store-mcp-option"
                      value={candidate.id}
                      checked={selected}
                      onChange={() => chooseOption(candidate.id)}
                    />
                    <span className="store-mcp-option-copy">
                      <span className="store-mcp-option-head">
                        <strong>{candidate.label}</strong>
                        <span className="tag">{candidate.transport}</span>
                      </span>
                      <code className="store-mcp-option-command">{previewText(candidate)}</code>
                    </span>
                  </label>
                );
              })}
            </div>
          </section>

          <div className="mcpm-form-grid store-mcp-fields">
            <label className="mcpm-field wide">
              <span>{pick(lang, STORE_TEXT.mcpName)}</span>
              <input
                ref={nameRef}
                className="control mono-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>

            {option.variables.map((variable) => (
              <label className="mcpm-field" key={variableKey(variable)}>
                <span>
                  <code>{variable.name}</code>{' '}
                  <span className="tag">{pick(lang, STORE_TEXT.mcpVariableRequired)}</span>
                  {variable.target === 'url' && (
                    <span className="hint">
                      {' '}
                      · {fill(pick(lang, STORE_TEXT.mcpUrlVariable), variable.name)}
                    </span>
                  )}
                  {variable.target === 'template' && (
                    <span className="hint">
                      {' '}
                      · {fill(pick(lang, STORE_TEXT.mcpTemplateVariable), variable.name)}
                    </span>
                  )}
                </span>
                <input
                  className="control mono-input"
                  type={variable.isSecret ? 'password' : 'text'}
                  autoComplete="off"
                  value={values[variableKey(variable)] ?? ''}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [variableKey(variable)]: event.target.value,
                    }))
                  }
                />
                {variable.description && <span className="hint">{variable.description}</span>}
              </label>
            ))}

            {option.variables.length === 0 && (
              <p className="hint wide">{pick(lang, STORE_TEXT.mcpNoVariables)}</p>
            )}
          </div>

          <div className="store-mcp-preview">
            <span className="store-targets-label">{pick(lang, STORE_TEXT.mcpPreview)}</span>
            <code>{previewText(option)}</code>
          </div>

          <p className="hint">
            {labels.length > 0
              ? fill(pick(lang, STORE_TEXT.mcpTargets), labels.join('、'))
              : pick(lang, STORE_TEXT.mcpOnlySource)}
          </p>
          {option.transport === 'sse' && <p className="warning">{pick(lang, STORE_TEXT.mcpSseWarning)}</p>}
          <p className="hint">{pick(lang, STORE_TEXT.mcpDialogHint)}</p>
        </div>

        {error && (
          <p className="confirm-dialog-error" role="alert">
            {error}
          </p>
        )}

        <div className="confirm-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            {pick(lang, STORE_TEXT.cancel)}
          </button>
          <button type="submit" className="primary" disabled={!canSubmit}>
            {busy ? pick(lang, STORE_TEXT.installing) : pick(lang, STORE_TEXT.install)}
          </button>
        </div>
      </form>
    </dialog>
  );
}
