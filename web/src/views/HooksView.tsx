import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorMessage, isAbortError } from '../api.ts';
import { useConfirmDialog } from '../lib/confirm.tsx';
import { hookStatesOf, needsAttention } from '../lib/attention.ts';
import type { HookActionKind, HookActionRequest, HookAgentInfo, HookMatrixReport, HookMatrixRow, HookState } from '../../../shared/types.ts';

const LABEL: Record<HookState, string> = { synced: '已同步', drift: '有差异', missing: '缺失', orphan: '孤儿', unsupported: '不支持', none: '不适用' };
type ToastKind = 'success' | 'warning' | 'error';
interface Toast { kind: ToastKind; text: string }
interface FormState { mode: 'new' | 'edit'; event: string; enabled: Record<string, boolean>; values: Record<string, string>; syncTo: string[]; error: string | null }

/** A question for the shared confirm dialog; `run` inside it performs the write. */
interface HookQuestion {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
}

function pretty(value: unknown[] | undefined) { return JSON.stringify(value ?? [], null, 2); }
function formatTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false }); }
function emptyForm(report: HookMatrixReport): FormState {
  const supported = report.agents.filter((a) => a.supported && (a.key === 'claude' || a.key === 'codex'));
  return { mode: 'new', event: '', enabled: {}, values: {}, syncTo: supported.map((a) => a.key), error: null };
}
function formFromRow(row: HookMatrixRow, report: HookMatrixReport): FormState {
  const enabled: Record<string, boolean> = {}; const values: Record<string, string> = {};
  for (const agent of report.agents) { if (agent.key === 'claude' || agent.key === 'codex') { enabled[agent.key] = Boolean(row.source?.[agent.key]); values[agent.key] = pretty(row.source?.[agent.key]); } }
  return { mode: 'edit', event: row.event, enabled, values, syncTo: report.agents.filter((a) => enabled[a.key]).map((a) => a.key), error: null };
}
/** Stable text of everything the user can edit, used to detect "has this form changed?" */
function serializeForm(form: FormState): string {
  return JSON.stringify([
    form.mode,
    form.event,
    form.enabled,
    form.values,
    form.syncTo,
  ]);
}

function cellActions(cell: HookState, row: HookMatrixRow): Array<{ action: HookActionKind; label: string }> {
  if (cell === 'synced') return [{ action: 'remove', label: '移除' }];
  if (cell === 'drift') return [{ action: 'sync', label: '同步' }, { action: 'import', label: '以此为准' }];
  if (cell === 'missing' && row.inSource) return [{ action: 'sync', label: '同步' }];
  if (cell === 'orphan') return [{ action: 'import', label: '收进源' }, { action: 'remove', label: '移除' }];
  return [];
}

/** Each cell action names the file it touches and whether anything is deleted. */
function hookConfirm(
  action: HookActionKind,
  event: string,
  agentLabel: string,
  row: HookMatrixRow,
): HookQuestion {
  if (action === 'remove')
    return {
      title: `从 ${agentLabel} 移除 ${event}`,
      message: `会删掉 ${agentLabel} 配置里的这个事件及其所有 matcher / handler，源文件和其它 agent 不受影响。`,
      confirmLabel: '移除',
      danger: true,
    };
  if (action === 'sync')
    return {
      title: `把 ${event} 同步到 ${agentLabel}`,
      message: `会用源里的写法覆盖 ${agentLabel} 的同名事件，写入前会自动建快照。`,
      confirmLabel: '同步',
      danger: false,
    };
  return row.inSource
    ? {
        title: `用 ${agentLabel} 的写法覆盖源`,
        message: `源里已有 ${event}。这一步会把源改成 ${agentLabel} 当前的写法，其它 agent 的定义不变，之后可用「同步到全部」对齐。`,
        confirmLabel: '覆盖源',
        danger: false,
      }
    : {
        title: `把 ${event} 收进源`,
        message: `会把 ${agentLabel} 里的这个事件写进源文件，之后可以一键同步到其它 agent。`,
        confirmLabel: '收进源',
        danger: false,
      };
}

export function HooksView({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [report, setReport] = useState<HookMatrixReport | null>(null); const [loadError, setLoadError] = useState<string | null>(null); const [loading, setLoading] = useState(false); const [busy, setBusy] = useState<string | null>(null); const [toast, setToast] = useState<Toast | null>(null); const [form, setForm] = useState<FormState | null>(null); const seq = useRef(0); const timer = useRef<number | undefined>(undefined);
  const [ask, confirmNode] = useConfirmDialog();
  /** Clicking a legend entry narrows the table to that state; null shows every row. */
  const [onlyState, setOnlyState] = useState<HookState | null>(null);
  // Snapshot of the form as opened, so closing can tell "nothing typed" from "would lose edits".
  const baselineRef = useRef('');
  // A ref, not the `busy` state: two clicks in one frame both see a null `busy` before React
  // re-renders, which would open two dialogs and send the write twice.
  const busyRef = useRef(false);
  const load = useCallback(async (signal?: AbortSignal) => { const current = ++seq.current; setLoading(true); try { const next = await api.hooks(signal); if (current !== seq.current) return; setReport(next); setLoadError(null); } catch (reason) { if (!signal?.aborted && !isAbortError(reason)) setLoadError(errorMessage(reason)); } finally { if (current === seq.current) setLoading(false); } }, []);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load, version]);
  // Same dwell times as the MCP page: a warning that also carries a snapshot id needs longer.
  const showToast = useCallback((kind: ToastKind, text: string) => { if (timer.current !== undefined) window.clearTimeout(timer.current); setToast({ kind, text }); timer.current = window.setTimeout(() => setToast(null), kind === 'success' ? 7_000 : 12_000); }, []);
  useEffect(() => () => { if (timer.current !== undefined) window.clearTimeout(timer.current); }, []);
  /** 执行一个写操作；成功返回 true。失败时错误显示在确认弹窗里，可在同一个弹窗里重试。 */
  async function run(key: string, body: HookActionRequest, question: HookQuestion): Promise<boolean> {
    if (busyRef.current) return false;
    return ask({ ...question, run: () => perform(key, body) });
  }

  /** The write itself; throws so the dialog can show the message and offer a retry. */
  async function perform(key: string, body: HookActionRequest): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(key);
    try {
      const result = await api.hookAction(body);
      setReport(result.report);
      const parts = [result.message, ...result.warnings.map((w) => `注意：${w}`)];
      if (result.snapshotIds.length) parts.push(`快照 ${result.snapshotIds.join('、')}`);
      showToast(result.warnings.length ? 'warning' : 'success', parts.join(' · '));
      onChanged();
    } finally {
      // A rejection propagates unchanged: the dialog renders the message, a toast would duplicate it.
      busyRef.current = false;
      setBusy(null);
    }
  }
  function openNew() {
    if (!report) return;
    const next = emptyForm(report);
    baselineRef.current = serializeForm(next);
    setForm(next);
  }
  function openEdit(row: HookMatrixRow) {
    if (!report) return;
    const next = formFromRow(row, report);
    baselineRef.current = serializeForm(next);
    setForm(next);
  }

  /** Closing drops whatever is typed in the form, so ask first when there is anything to lose. */
  async function closeForm() {
    if (!form || busy) return;
    if (serializeForm(form) !== baselineRef.current) {
      const discard = await ask({
        title: '放弃这个事件？',
        danger: true,
        message: `「${form.event.trim() || '未命名事件'}」里填写的内容还没有保存，关闭后会丢掉。`,
        confirmLabel: '放弃并关闭',
      });
      if (!discard) return;
    }
    setForm(null);
  }
  async function submit(event: FormEvent) { event.preventDefault(); if (!form || !report) return; const definitions: Record<string, unknown[]> = {}; for (const key of ['claude', 'codex']) { if (!form.enabled[key]) continue; try { const parsed: unknown = JSON.parse(form.values[key] ?? ''); if (!Array.isArray(parsed)) throw new Error('必须是 JSON 数组'); definitions[key] = parsed; } catch (reason) { setForm({ ...form, error: `${key === 'claude' ? 'Claude Code' : 'Codex'} 配置：${errorMessage(reason)}` }); return; } } if (!form.event.trim()) { setForm({ ...form, error: '请填写事件名' }); return; } const eventName = form.event.trim(); const ok = await run('saveSource', { action: 'saveSource', event: eventName, definitions, agents: form.syncTo }, { title: `保存事件 ${eventName}`, message: `会写入源文件${form.syncTo.length > 0 ? `，并同步到 ${form.syncTo.length} 个 agent` : ''}。写入前会自动建快照。`, confirmLabel: '保存', danger: false }); if (ok) { baselineRef.current = ''; setForm(null); } }
  if (!report && loadError) return <div className="error">读取 Hooks 失败：{loadError}<button type="button" onClick={() => void load()}>重试</button></div>;
  if (!report) return <p className="muted">扫描中…</p>;
  const disabled = busy !== null; const empty = report.rows.length === 0;
  const stateCounts = new Map<HookState, number>();
  let attentionRows = 0;
  for (const row of report.rows) {
    const states = hookStatesOf(row, report);
    for (const state of states) stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1);
    if ([...states].some(needsAttention)) attentionRows += 1;
  }
  const visibleRows = onlyState === null ? report.rows : report.rows.filter((row) => hookStatesOf(row, report).has(onlyState));
  return <section className="hook-page">
    <div className="mcpm-head"><div className="mcpm-head-copy"><p className="meta">源 <code>{report.source.path}</code> · {report.source.exists ? '已存在' : '不存在'} · {report.source.eventCount} 个事件 · 上次扫描 {formatTime(report.scannedAt)}</p>{!report.source.exists && <p className="hint">源文件还没有建立：先从任一 agent 的 event 收进源，或直接导入。</p>}</div><div className="mcpm-head-actions"><button className="primary" type="button" disabled={disabled} onClick={openNew}>新增事件</button><button type="button" disabled={disabled} onClick={() => void run('importAll', { action: 'importAll', prefer: 'claude' }, { title: '从现有配置导入 hooks', message: '会把各 agent 有、源里缺少的 hook 定义批量收进源文件。同名事件以 Claude Code 为准，写入前会自动建快照。', confirmLabel: '导入', danger: false })}>{busy === 'importAll' ? '导入中…' : '从现有配置导入'}</button><button type="button" disabled={loading} onClick={() => void load()}>{loading ? '刷新中…' : '刷新'}</button></div></div>
    {report.warnings?.map((warning) => <p className="warning" key={warning}>{warning}</p>)}
    {loadError && <div className="error">刷新失败：{loadError}（显示的是上次扫描结果）<button type="button" onClick={() => void load()}>重试</button></div>}
    <div className="legend-bar">
      <ul className="legend mcpm-legend hook-legend" aria-label="状态图例">
        {(Object.keys(LABEL) as HookState[]).map((state) => {
          const count = stateCounts.get(state) ?? 0;
          return (
            <li key={state}>
              <button
                type="button"
                className="legend-filter"
                aria-pressed={onlyState === state}
                title={count > 0 ? `只看${LABEL[state]}的事件` : `没有${LABEL[state]}的事件`}
                disabled={count === 0}
                onClick={() => setOnlyState((current) => (current === state ? null : state))}
              >
                <span className={`mcpm-dot mcpm-${state}`} aria-hidden="true" /> {LABEL[state]}
                <span className="legend-count">{count}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {onlyState !== null && <button type="button" className="legend-clear" onClick={() => setOnlyState(null)}>显示全部 {report.rows.length} 行</button>}
      {onlyState === null && attentionRows > 0 && <span className="legend-hint">点图例可按状态筛选 · {attentionRows} 行需处理</span>}
    </div>
    {form && <HookForm form={form} report={report} disabled={disabled} onPatch={(patch) => setForm((current) => current ? { ...current, ...patch, error: null } : current)} onToggle={(key, checked) => setForm((current) => current ? { ...current, enabled: { ...current.enabled, [key]: checked } } : current)} onSync={(key, checked) => setForm((current) => current ? { ...current, syncTo: checked ? [...new Set([...current.syncTo, key])] : current.syncTo.filter((item) => item !== key) } : current)} onSubmit={submit} onCancel={() => void closeForm()} />}
    {empty ? <div className="mcpm-empty"><p>还没有 hooks。</p><p className="hint">源和各 agent 的配置里都没有找到 hooks，可以新增一个，或从现有配置导入。</p><div className="mcpm-head-actions"><button className="primary" type="button" disabled={disabled} onClick={openNew}>新增事件</button><button type="button" disabled={disabled} onClick={() => void run('importAll', { action: 'importAll', prefer: 'claude' }, { title: '从现有配置导入 hooks', message: '会把各 agent 有、源里缺少的 hook 定义批量收进源文件。同名事件以 Claude Code 为准，写入前会自动建快照。', confirmLabel: '导入', danger: false })}>从现有配置导入</button></div></div> : <div className="table-wrap"><table className="mcpm-table hook-table"><caption className="sr-only">Hooks 在源与各 agent 中的分布</caption><thead><tr><th scope="col">event</th><th scope="col">源</th>{report.agents.map((agent) => <th scope="col" key={agent.key} title={agent.file}>{agent.label}<span className="count">{agent.format}</span></th>)}<th scope="col">操作</th></tr></thead><tbody>
                {visibleRows.map((row) => (
                  <tr key={row.event}>
                    <th scope="row">{row.event}</th>
                    <td className={row.inSource ? 'mcpm-source in' : 'mcpm-source'}>
                      {row.inSource ? '已入源' : '未入源'}
                      {row.sourceAgents.length > 0 && <span className="mcpm-summary">{row.sourceAgents.join('、')}</span>}
                    </td>
                    {report.agents.map((agent) => {
                      const cell = row.cells[agent.key] ?? { state: (agent.supported ? 'none' : 'unsupported') as HookState };
                      const actions = cellActions(cell.state, row);
                      return (
                        <td className={`mcpm-cell mcpm-${cell.state}`} key={agent.key}>
                          <span className="mcpm-state">{LABEL[cell.state]}</span>
                          {cell.summary && <span className="mcpm-summary" title={cell.summary}>{cell.summary}</span>}
                          {cell.error && <span className="mcpm-cell-error">{cell.error}</span>}
                          {actions.length > 0 && (
                            <span className="cell-actions">
                              {actions.map((entry) => {
                                const key = `${entry.action}:${row.event}:${agent.key}`;
                                const body: HookActionRequest = entry.action === 'sync'
                                  ? { action: 'sync', event: row.event, agent: agent.key, agents: [agent.key] }
                                  : { action: entry.action, event: row.event, agent: agent.key };
                                return (
                                  <button
                                    type="button"
                                    key={entry.action}
                                    disabled={disabled}
                                    aria-label={`${entry.label}：${row.event}（${agent.label}）`}
                                    onClick={() => void run(key, body, hookConfirm(entry.action, row.event, agent.label, row))}
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
                          <button type="button" disabled={disabled} aria-label={`编辑源：${row.event}`} onClick={() => openEdit(row)}>编辑源</button>
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => void run(`sync:${row.event}`, { action: 'sync', event: row.event }, {
                              title: `同步 ${row.event} 到全部 agent`,
                              message: '会用源里的写法覆盖每个 agent 的同名事件，写入前会自动建快照。Codex 需在 /hooks 里重新信任才会执行。',
                              confirmLabel: '同步到全部',
                              danger: false,
                            })}
                          >
                            同步到全部
                          </button>
                          <button
                            type="button"
                            className="danger"
                            disabled={disabled}
                            onClick={() => void run(`delete:${row.event}`, { action: 'deleteSource', event: row.event }, {
                              title: `从源删除 ${row.event}`,
                              message: '只会删掉源文件里的这个事件，各 agent 里已同步的 hook 会保留并变成「孤儿」，之后可以逐个移除。',
                              confirmLabel: '从源删除',
                              danger: true,
                            })}
                          >
                            从源删除
                          </button>
                        </span>
                      ) : (
                        <span className="hint">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody></table></div>}
    {toast && <div className={`toast toast-${toast.kind}`} role="status" aria-live="polite"><span>{toast.text}</span><button type="button" className="icon-button" aria-label="关闭提示" onClick={() => setToast(null)}>×</button></div>}
    {confirmNode}
  </section>;
}

function HookForm({ form, report, disabled, onPatch, onToggle, onSync, onSubmit, onCancel }: { form: FormState; report: HookMatrixReport; disabled: boolean; onPatch: (patch: Partial<FormState>) => void; onToggle: (key: string, checked: boolean) => void; onSync: (key: string, checked: boolean) => void; onSubmit: (event: FormEvent) => void; onCancel: () => void }) {
  return <form className="mcpm-form hook-form" onSubmit={onSubmit} aria-label={form.mode === 'edit' ? `编辑源：${form.event}` : '新增 hook 事件'} onKeyDown={(event) => { if (event.key === 'Escape') onCancel(); }} noValidate><header className="panel-head"><div><h2>{form.mode === 'edit' ? `编辑源：${form.event}` : '新增 hook 事件'}</h2><p className="meta">保存到源文件；勾选的 agent 会在保存后立即同步。</p></div></header><label className="mcpm-field"><span>事件名</span><input className="control mono-input" list="hook-events" value={form.event} readOnly={form.mode === 'edit'} autoFocus={form.mode === 'new'} onChange={(event) => onPatch({ event: event.target.value })} /><datalist id="hook-events">{report.events.map((event) => <option key={event} value={event} />)}</datalist></label><div className="hook-definitions">{report.agents.filter((agent) => agent.key === 'claude' || agent.key === 'codex').map((agent) => <fieldset className={form.enabled[agent.key] ? 'hook-definition is-on' : 'hook-definition is-off'} key={agent.key}><legend><label className="check"><input type="checkbox" checked={Boolean(form.enabled[agent.key])} onChange={(event) => onToggle(agent.key, event.target.checked)} />为此 agent 定义</label></legend>{agent.key === 'codex' && <p className="field-warning">Codex 修改后需在 /hooks 重新信任才会执行</p>}{form.enabled[agent.key] && <textarea className="control mono-input" rows={8} value={form.values[agent.key] ?? '[]'} onChange={(event) => onPatch({ values: { ...form.values, [agent.key]: event.target.value } })} aria-label={`${agent.label} hooks JSON`} />}</fieldset>)}<p className="hint">pi 没有原生 hooks，不支持同步。</p></div><fieldset className="mcpm-sync"><legend>保存后同步到</legend>{report.agents.filter((agent) => agent.key === 'claude' || agent.key === 'codex').map((agent) => <label className="check" key={agent.key}><input type="checkbox" checked={form.syncTo.includes(agent.key)} onChange={(event) => onSync(agent.key, event.target.checked)} />{agent.label}</label>)}</fieldset>{form.error && <p className="field-error" role="alert">{form.error}</p>}<div className="mcpm-form-actions"><button type="submit" className="primary" disabled={disabled}>{disabled ? '保存中…' : '保存'}</button><button type="button" onClick={onCancel} disabled={disabled}>取消</button></div></form>;
}
