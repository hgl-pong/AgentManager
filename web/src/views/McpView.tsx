import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, RefObject } from 'react';
import { api, errorMessage, isAbortError } from '../api.ts';
import { useConfirmDialog } from '../lib/confirm.tsx';
import type {
  McpActionKind,
  McpActionRequest,
  McpAgentInfo,
  McpMatrixCell,
  McpMatrixReport,
  McpMatrixRow,
  McpServerDefinition,
  McpState,
  McpTransport,
} from '../../../shared/types.ts';

const STATE_LABEL: Record<McpState, string> = {
  synced: '已同步',
  drift: '有差异',
  missing: '缺失',
  orphan: '孤儿',
  invalid: '无效',
  unsupported: '不支持',
};

/** Codex 与 pi 只支持 stdio / http，sse 只能同步到 Claude Code。 */
const SSE_AGENTS = new Set(['claude']);

type ToastKind = 'success' | 'warning' | 'error';

interface Toast {
  kind: ToastKind;
  text: string;
}

interface FormState {
  mode: 'new' | 'edit';
  name: string;
  transport: McpTransport;
  command: string;
  args: string;
  cwd: string;
  env: string;
  url: string;
  headers: string;
  syncTo: string[];
  error: string | null;
}

interface CellAction {
  action: McpActionKind;
  label: string;
}

/** A question for the shared confirm dialog; `run` inside it performs the write. */
interface McpQuestion {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
}

function cellActions(cell: McpMatrixCell, row: McpMatrixRow): CellAction[] {
  switch (cell.state) {
    case 'synced':
      return [{ action: 'remove', label: '移除' }];
    case 'drift':
      return [
        { action: 'sync', label: '同步' },
        { action: 'import', label: '以此为准' },
      ];
    case 'missing':
      return row.inSource ? [{ action: 'sync', label: '同步' }] : [];
    case 'orphan':
      return [
        { action: 'import', label: '收进源' },
        { action: 'remove', label: '移除' },
      ];
    case 'invalid':
      return [{ action: 'remove', label: '移除' }];
    default:
      return [];
  }
}

function confirmText(
  action: McpActionKind,
  name: string,
  agent: McpAgentInfo,
  row: McpMatrixRow,
): McpQuestion {
  if (action === 'remove')
    return {
      title: `从 ${agent.label} 移除 ${name}`,
      message: `会从 ${agent.label} 的配置文件里删掉这个 MCP server，源文件和其它 agent 不受影响。`,
      confirmLabel: '移除',
      danger: true,
    };
  if (action === 'sync')
    return {
      title: `把 ${name} 同步到 ${agent.label}`,
      message: `用源里的定义覆盖 ${agent.label} 现有的同名配置，写入前会自动建快照。`,
      confirmLabel: '同步',
      danger: false,
    };
  return row.inSource
    ? {
        title: `用 ${agent.label} 的定义覆盖源`,
        message: `源里已有 ${name}。这一步会把源改成 ${agent.label} 当前的写法，其它 agent 的配置不变，之后可用「同步到全部」对齐。`,
        confirmLabel: '覆盖源',
        danger: false,
      }
    : {
        title: `把 ${name} 收进源`,
        message: `会把 ${agent.label} 里的这个 MCP server 写进源文件，之后可以一键同步到其它 agent。`,
        confirmLabel: '收进源',
        danger: false,
      };
}

function emptyForm(agents: McpAgentInfo[]): FormState {
  return {
    mode: 'new',
    name: '',
    transport: 'stdio',
    command: '',
    args: '',
    cwd: '',
    env: '',
    url: '',
    headers: '',
    syncTo: agents.map((agent) => agent.key),
    error: null,
  };
}

/** Stable text of everything the user can edit, used to detect "has this form changed?" */
function serializeForm(form: FormState): string {
  return JSON.stringify([
    form.mode,
    form.name,
    form.transport,
    form.command,
    form.args,
    form.cwd,
    form.env,
    form.url,
    form.headers,
    form.syncTo,
  ]);
}

function pairsToText(pairs: Record<string, string> | undefined): string {
  return Object.entries(pairs ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function formFromSource(name: string, source: McpServerDefinition, agents: McpAgentInfo[]): FormState {
  return {
    mode: 'edit',
    name,
    transport: source.transport,
    command: source.command ?? '',
    args: (source.args ?? []).join('\n'),
    cwd: source.cwd ?? '',
    env: pairsToText(source.env),
    url: source.url ?? '',
    headers: pairsToText(source.headers),
    syncTo: agents.map((agent) => agent.key),
    error: null,
  };
}

/** 解析每行一个 KEY=VALUE；返回错误文案或解析结果。 */
function parsePairs(text: string, label: string): Record<string, string> | string {
  const result: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (line === '') continue;
    const eq = line.indexOf('=');
    const key = eq > 0 ? line.slice(0, eq).trim() : '';
    if (key === '' || /\s/.test(key)) return `${label}第 ${index + 1} 行不是 KEY=VALUE 格式：${line}`;
    result[key] = line.slice(eq + 1).trim();
  }
  return result;
}

function supports(agentKey: string, transport: McpTransport): boolean {
  return transport !== 'sse' || SSE_AGENTS.has(agentKey);
}

function buildServer(form: FormState): McpServerDefinition | string {
  if (form.name.trim() === '') return '请填写名称';
  if (/[\s"'`]/.test(form.name.trim())) return '名称不能包含空白或引号';
  if (form.transport === 'stdio') {
    if (form.command.trim() === '') return 'stdio 需要填写 command';
    const env = parsePairs(form.env, 'env ');
    if (typeof env === 'string') return env;
    const args = form.args
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const server: McpServerDefinition = { transport: 'stdio', command: form.command.trim() };
    if (args.length > 0) server.args = args;
    if (form.cwd.trim() !== '') server.cwd = form.cwd.trim();
    if (Object.keys(env).length > 0) server.env = env;
    return server;
  }
  const url = form.url.trim();
  if (url === '') return `${form.transport} 需要填写 url`;
  if (!/^https?:\/\/\S+$/i.test(url)) return 'url 需要以 http:// 或 https:// 开头';
  const headers = parsePairs(form.headers, 'headers ');
  if (typeof headers === 'string') return headers;
  const server: McpServerDefinition = { transport: form.transport, url };
  if (Object.keys(headers).length > 0) server.headers = headers;
  return server;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

export function McpView({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [report, setReport] = useState<McpMatrixReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const seqRef = useRef(0);
  const toastTimer = useRef<number | undefined>(undefined);
  const formRef = useRef<HTMLFormElement | null>(null);
  const [ask, confirmNode] = useConfirmDialog();
  // Snapshot of the form as opened, so closing can tell "nothing typed" from "would lose edits".
  const baselineRef = useRef('');

  const load = useCallback(async (signal?: AbortSignal) => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const next = await api.mcp(signal);
      if (seq !== seqRef.current) return;
      setReport(next);
      setLoadError(null);
    } catch (reason) {
      if (seq !== seqRef.current || signal?.aborted || isAbortError(reason)) return;
      setLoadError(errorMessage(reason));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, version]);

  const showToast = useCallback((kind: ToastKind, text: string) => {
    if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
    setToast({ kind, text });
    toastTimer.current = window.setTimeout(() => setToast(null), kind === 'success' ? 7_000 : 12_000);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  // 只在面板打开或切换编辑对象时滚动，输入时不动。
  const formKey = form ? (form.mode === 'edit' ? `edit:${form.name}` : 'new') : null;
  useEffect(() => {
    if (formKey) formRef.current?.scrollIntoView({ block: 'nearest' });
  }, [formKey]);

  /**
   * Runs one write. With a `question` the dialog performs it and keeps a failure inside itself;
   * without one the caller gets the error back so it can show it in its own form.
   */
  async function run(
    key: string,
    body: McpActionRequest,
    question: McpQuestion | null,
  ): Promise<boolean | string> {
    if (busy) return false;
    if (question !== null) return ask({ ...question, run: () => perform(key, body) });
    try {
      await perform(key, body, { toastOnError: true });
      return true;
    } catch (reason) {
      return errorMessage(reason);
    }
  }

  /** The write itself; throws so the caller can show the message where the action started. */
  async function perform(
    key: string,
    body: McpActionRequest,
    { toastOnError = false }: { toastOnError?: boolean } = {},
  ): Promise<void> {
    setBusy(key);
    try {
      const result = await api.mcpAction(body);
      setReport(result.report);
      const parts = [result.message];
      if (result.warnings.length > 0) parts.push(...result.warnings.map((warning) => `注意：${warning}`));
      if (result.snapshotIds.length > 0) parts.push(`快照 ${result.snapshotIds.join('、')}`);
      showToast(result.warnings.length > 0 ? 'warning' : 'success', parts.join(' · '));
      onChanged();
    } catch (reason) {
      // Inside the dialog the message is already rendered there; toasting it too would duplicate it.
      if (toastOnError) showToast('error', `操作失败：${errorMessage(reason)}`);
      throw reason;
    } finally {
      setBusy(null);
    }
  }

  function importAll() {
    void run('importAll', { action: 'importAll', prefer: 'claude' }, {
      title: '把 agent 现有配置收进源',
      message:
        '会把各 agent 已配置、源里还没有的 MCP server 收进源文件。同名定义不一致时以 Claude Code 的写法为准，写入前会自动建快照。',
      confirmLabel: '收进源',
      danger: false,
    });
  }

  function openNew() {
    if (!report) return;
    const next = emptyForm(report.agents);
    baselineRef.current = serializeForm(next);
    setForm(next);
  }

  function openEdit(row: McpMatrixRow) {
    if (!report || !row.source) return;
    const next = formFromSource(row.name, row.source, report.agents);
    baselineRef.current = serializeForm(next);
    setForm(next);
  }

  /** True when the open form holds edits that differ from what it was opened with. */
  function formDirty(): boolean {
    return form !== null && serializeForm(form) !== baselineRef.current;
  }

  /** Closing drops whatever is typed in the form, so ask first when there is anything to lose. */
  async function closeForm() {
    if (!form || busy) return;
    if (formDirty()) {
      const discard = await ask({
        title: '放弃这个表单？',
        danger: true,
        message: `「${form.name.trim() || '未命名'}」里填写的内容还没有保存，关闭后会丢掉。`,
        confirmLabel: '放弃并关闭',
      });
      if (!discard) return;
    }
    setForm(null);
  }

  function patch(next: Partial<FormState>) {
    setForm((current) => (current ? { ...current, ...next, error: null } : current));
  }

  function toggleSync(agentKey: string, checked: boolean) {
    setForm((current) => {
      if (!current) return current;
      const syncTo = checked
        ? [...new Set([...current.syncTo, agentKey])]
        : current.syncTo.filter((key) => key !== agentKey);
      return { ...current, syncTo };
    });
  }

  async function submit(event: FormEvent) {    event.preventDefault();
    if (!form || !report) return;
    const server = buildServer(form);
    if (typeof server === 'string') {
      setForm({ ...form, error: server });
      return;
    }
    const name = form.name.trim();
    const agents = form.syncTo.filter((key) => supports(key, form.transport));
    const exists = report.rows.some((row) => row.name === name && row.inSource);
    const targets = report.agents.filter((agent) => agents.includes(agent.key)).map((agent) => agent.label);
    const question =
      form.mode === 'new' && exists
        ? {
            title: `覆盖源里的 ${name}`,
            message: `源文件里已经有同名 server。保存会用当前表单的定义覆盖它，然后再同步到选中的 agent。`,
            confirmLabel: '覆盖并保存',
            danger: false,
          }
        : {
            title: `保存 ${name}`,
            message: `
              会写入源文件${targets.length > 0 ? `，并同步到 ${targets.join('、')}` : ''}。写入前会自动建快照。
            `,
            confirmLabel: '保存',
            danger: false,
          };
    const result = await run('saveSource', { action: 'saveSource', name, server, agents }, question);
    // A successful save means the form content is on disk; closing afterwards must not ask again.
    if (result === true) {
      baselineRef.current = '';
      setForm(null);
    } else if (typeof result === 'string') setForm((current) => (current ? { ...current, error: result } : current));
  }

  if (!report && loadError) {
    return (
      <div className="error">
        读取 MCP 失败：{loadError}
        <button type="button" onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  }
  if (!report) return <p className="muted">扫描中…</p>;

  const disabled = busy !== null;
  const empty = report.rows.length === 0;

  return (
    <section className="mcpm-page">
      <div className="mcpm-head">
        <div className="mcpm-head-copy">
          <p className="meta">
            源 <code>{report.source.path}</code> · {report.source.exists ? '已存在' : '不存在'} ·{' '}
            {report.source.serverCount} 个 server · 上次扫描 {formatTime(report.scannedAt)}
          </p>
          {!report.source.exists && (
            <p className="hint">源文件还没有建立：先在矩阵里把任一 agent 的 server 收进源，或直接从现有配置导入。</p>
          )}
        </div>
        <div className="mcpm-head-actions">
          <button type="button" className="primary" onClick={openNew} disabled={disabled}>
            新增 server
          </button>
          <button type="button" onClick={importAll} disabled={disabled}>
            {busy === 'importAll' ? '导入中…' : '从现有配置导入'}
          </button>
          <button type="button" onClick={() => void load()} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>

      {report.source.error && <p className="error">源文件读取失败：{report.source.error}</p>}
      {loadError && (
        <div className="error">
          刷新失败：{loadError}（显示的是上次扫描结果）
          <button type="button" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}

      <ul className="legend mcpm-legend" aria-label="状态图例">
        {(Object.keys(STATE_LABEL) as McpState[]).map((state) => (
          <li key={state}>
            <span className={`mcpm-dot mcpm-${state}`} aria-hidden="true" /> {STATE_LABEL[state]}
          </li>
        ))}
      </ul>

      {form && (
        <McpForm
          form={form}
          agents={report.agents}
          formRef={formRef}
          busy={busy === 'saveSource'}
          disabled={disabled}
          onPatch={patch}
          onToggleSync={toggleSync}
          onSubmit={submit}
          onCancel={() => void closeForm()}
        />
      )}

      {empty ? (
        <div className="mcpm-empty">
          <p>还没有 MCP server。</p>
          <p className="hint">源和各 agent 的配置里都没有找到 MCP server，可以新增一个，或从现有配置导入。</p>
          <div className="mcpm-head-actions">
            <button type="button" className="primary" onClick={openNew} disabled={disabled}>
              新增 server
            </button>
            <button type="button" onClick={importAll} disabled={disabled}>
              从现有配置导入
            </button>
          </div>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="mcpm-table">
            <caption className="sr-only">MCP server 在源与各 agent 中的分布</caption>
            <thead>
              <tr>
                <th scope="col">server</th>
                <th scope="col">源</th>
                {report.agents.map((agent) => (
                  <th key={agent.key} scope="col" title={agent.file}>
                    {agent.label}
                    <span className="count">{agent.format}</span>
                  </th>
                ))}
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.name} className={row.inSource ? 'from-source' : 'outside-source'}>
                  <th scope="row">{row.name}</th>
                  <td className={row.inSource ? 'mcpm-source in' : 'mcpm-source'}>
                    {row.inSource ? '已入源' : '未入源'}
                    {row.source && <span className="mcpm-summary">{row.source.transport}</span>}
                  </td>
                  {report.agents.map((agent) => {
                    const cell = row.cells[agent.key] ?? { state: 'missing' as McpState };
                    const actions = cellActions(cell, row);
                    return (
                      <td key={agent.key} className={`mcpm-cell mcpm-${cell.state}`}>
                        <span className="mcpm-state">{STATE_LABEL[cell.state]}</span>
                        {cell.summary && (
                          <span className="mcpm-summary" title={cell.summary}>
                            {cell.summary}
                          </span>
                        )}
                        {cell.error && <span className="mcpm-cell-error">{cell.error}</span>}
                        {actions.length > 0 && (
                          <span className="cell-actions">
                            {actions.map((entry) => {
                              const key = `${entry.action}:${row.name}:${agent.key}`;
                              return (
                                <button
                                  key={entry.action}
                                  type="button"
                                  disabled={disabled}
                                  aria-label={`${entry.label}：${row.name}（${agent.label}）`}
                                  onClick={() =>
                                    void run(
                                      key,
                                      entry.action === 'sync'
                                        ? { action: 'sync', name: row.name, agent: agent.key, agents: [agent.key] }
                                        : { action: entry.action, name: row.name, agent: agent.key },
                                      confirmText(entry.action, row.name, agent, row),
                                    )
                                  }
                                >
                                  {busy === key ? '执行中…' : entry.label}
                                </button>
                              );
                            })}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  <td className="mcpm-row-actions">
                    {row.inSource ? (
                      <span className="cell-actions">
                        <button
                          type="button"
                          disabled={disabled}
                          aria-label={`编辑源：${row.name}`}
                          onClick={() => openEdit(row)}
                        >
                          编辑源
                        </button>
                        <button
                          type="button"
                          disabled={disabled}
                          aria-label={`同步到全部：${row.name}`}
                          onClick={() =>
                            void run(
                              `sync:${row.name}`,
                              { action: 'sync', name: row.name },
                              {
                                title: `同步 ${row.name} 到全部 agent`,
                                message: `会用源里的定义覆盖每个 agent 的现有配置，写入前会自动建快照。`,
                                confirmLabel: '同步到全部',
                                danger: false,
                              },
                            )
                          }
                        >
                          {busy === `sync:${row.name}` ? '执行中…' : '同步到全部'}
                        </button>
                        <button
                          type="button"
                          className="danger"
                          disabled={disabled}
                          aria-label={`从源删除：${row.name}`}
                          onClick={() =>
                            void run(
                              `deleteSource:${row.name}`,
                              { action: 'deleteSource', name: row.name },
                              {
                                title: `从源删除 ${row.name}`,
                                message:
                                  '只会删掉源文件里的这一条，各 agent 里已同步的配置会保留并变成「孤儿」，之后可以逐个移除。',
                                confirmLabel: '从源删除',
                                danger: true,
                              },
                            )
                          }
                        >
                          {busy === `deleteSource:${row.name}` ? '执行中…' : '从源删除'}
                        </button>
                      </span>
                    ) : (
                      <span className="hint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {toast && (
        <div className={`toast toast-${toast.kind}`} role="status" aria-live="polite">
          <span>{toast.text}</span>
          <button type="button" className="icon-button" onClick={() => setToast(null)} aria-label="关闭提示">
            ×
          </button>
        </div>
      )}
      {confirmNode}
    </section>
  );
}

interface McpFormProps {
  form: FormState;
  agents: McpAgentInfo[];
  formRef: RefObject<HTMLFormElement | null>;
  busy: boolean;
  disabled: boolean;
  onPatch: (next: Partial<FormState>) => void;
  onToggleSync: (agentKey: string, checked: boolean) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}

function McpForm({ form, agents, formRef, busy, disabled, onPatch, onToggleSync, onSubmit, onCancel }: McpFormProps) {
  const stdio = form.transport === 'stdio';
  const title = form.mode === 'edit' ? `编辑源：${form.name}` : '新增 MCP server';
  return (
    <form
      className="mcpm-form"
      ref={formRef}
      onSubmit={onSubmit}
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
      noValidate
    >
      <header className="panel-head">
        <div>
          <h2>{title}</h2>
          <p className="meta">保存到源文件；勾选的 agent 会在保存后立即同步。</p>
        </div>
      </header>

      <div className="mcpm-form-grid">
        <label className="mcpm-field">
          <span>名称</span>
          <input
            className="control mono-input"
            value={form.name}
            readOnly={form.mode === 'edit'}
            autoFocus={form.mode === 'new'}
            onChange={(event) => onPatch({ name: event.target.value })}
            placeholder="例如 filesystem"
          />
        </label>
        <label className="mcpm-field">
          <span>传输</span>
          <select
            className="control"
            value={form.transport}
            autoFocus={form.mode === 'edit'}
            onChange={(event) => onPatch({ transport: event.target.value as McpTransport })}
          >
            <option value="stdio">stdio</option>
            <option value="http">http</option>
            <option value="sse">sse</option>
          </select>
        </label>

        {stdio ? (
          <>
            <label className="mcpm-field wide">
              <span>command</span>
              <input
                className="control mono-input"
                value={form.command}
                onChange={(event) => onPatch({ command: event.target.value })}
                placeholder="例如 npx"
              />
            </label>
            <label className="mcpm-field">
              <span>args（每行一个）</span>
              <textarea
                className="control mono-input"
                rows={4}
                value={form.args}
                onChange={(event) => onPatch({ args: event.target.value })}
              />
            </label>
            <label className="mcpm-field">
              <span>env（每行 KEY=VALUE）</span>
              <textarea
                className="control mono-input"
                rows={4}
                value={form.env}
                onChange={(event) => onPatch({ env: event.target.value })}
              />
            </label>
            <label className="mcpm-field wide">
              <span>cwd</span>
              <input
                className="control mono-input"
                value={form.cwd}
                onChange={(event) => onPatch({ cwd: event.target.value })}
                placeholder="可留空"
              />
            </label>
          </>
        ) : (
          <>
            <label className="mcpm-field wide">
              <span>url</span>
              <input
                className="control mono-input"
                type="url"
                value={form.url}
                onChange={(event) => onPatch({ url: event.target.value })}
                placeholder="https://example.com/mcp"
              />
            </label>
            <label className="mcpm-field wide">
              <span>headers（每行 KEY=VALUE）</span>
              <textarea
                className="control mono-input"
                rows={3}
                value={form.headers}
                onChange={(event) => onPatch({ headers: event.target.value })}
              />
            </label>
            {form.transport === 'sse' && (
              <p className="field-warning wide">Codex 与 pi 不支持 sse，只能同步到 Claude Code。</p>
            )}
          </>
        )}
      </div>

      <fieldset className="mcpm-sync">
        <legend>保存后同步到</legend>
        {agents.map((agent) => {
          const ok = supports(agent.key, form.transport);
          return (
            <label key={agent.key} className="check" title={ok ? agent.file : `${agent.label} 不支持 ${form.transport}`}>
              <input
                type="checkbox"
                checked={ok && form.syncTo.includes(agent.key)}
                disabled={!ok}
                onChange={(event) => onToggleSync(agent.key, event.target.checked)}
              />
              <span>
                {agent.label}
                {!ok && '（不支持）'}
              </span>
            </label>
          );
        })}
      </fieldset>

      {form.error && (
        <p className="field-error" role="alert">
          {form.error}
        </p>
      )}

      <div className="mcpm-form-actions">
        <button type="submit" className="primary" disabled={disabled}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
    </form>
  );
}
