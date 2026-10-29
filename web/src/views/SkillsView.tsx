import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, isAbortError } from '../api.ts';
import type { Cell, CellState, MatrixResponse, Row, SkillActionKind } from '../../../shared/types.ts';

const ICON: Record<CellState, string> = {
  linked: '🔗',
  broken: '🔗✗',
  external: '🔗↗',
  copy: '📄',
  orphan: '⚠',
  missing: '—',
};

const LABEL: Record<CellState, string> = {
  linked: '已链接',
  broken: '链接失效',
  external: '外部链接',
  copy: '副本',
  orphan: '孤儿',
  missing: '缺失',
};

/** 对 agent 真正生效的分布：链接到源、外部链接、以及副本。 */
const EFFECTIVE: CellState[] = ['linked', 'external', 'copy'];

interface Pending {
  agent: string;
  agentLabel: string;
  name: string;
  action: SkillActionKind;
  label: string;
}

function actionsFor(cell: Cell, row: Row): { action: SkillActionKind; label: string }[] {
  if (cell.state === 'missing' && row.inSource) return [{ action: 'link', label: '建链' }];
  if (cell.state === 'broken') return [{ action: 'unlink', label: '移除坏链' }];
  if (cell.state === 'copy') return [{ action: 'remove', label: '移除副本' }];
  if (cell.state === 'orphan')
    return [
      { action: 'import', label: '收进源' },
      { action: 'remove', label: '移除副本' },
    ];
  return [];
}

export function SkillsView({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [matrix, setMatrix] = useState<MatrixResponse | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const seq = ++seqRef.current;
    try {
      const next = await api.matrix(signal);
      if (seq !== seqRef.current) return;
      setMatrix(next);
      setError(null);
      setLoadError(null);
    } catch (reason) {
      if (seq !== seqRef.current || signal?.aborted || isAbortError(reason)) return;
      setLoadError(errorMessage(reason));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, version]);

  function requestAction(next: Pending) {
    setNotice(null);
    setPending(next);
  }

  async function confirm() {
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.skill({ agent: pending.agent, action: pending.action, name: pending.name });
      setMatrix(result.matrix);
      setNotice(`${result.message} · 快照 ${result.snapshotId}`);
      setPending(null);
      onChanged();
    } catch (reason) {
      setNotice(null);
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!matrix && loadError) {
    return (
      <div className="error">
        扫描失败：{loadError}
        <button type="button" onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  }
  if (!matrix) return <p className="muted">扫描中…</p>;

  return (
    <section>
      <div className="toolbar">
        <p className="meta">
          源 <code>{matrix.source.path}</code> · {matrix.source.skills.length} 个 skill · {matrix.rows.length} 行 ·
          扫描耗时 {matrix.durationMs}ms
        </p>
        <ul className="legend">
          {(Object.keys(LABEL) as CellState[]).map((state) => (
            <li key={state} className={`state-${state}`}>
              <span aria-hidden="true">{ICON[state]}</span> {LABEL[state]}
            </li>
          ))}
          <li>
            <span aria-hidden="true">≠</span> 副本与源不同
          </li>
          {matrix.agents.some((agent) => !agent.detected) && (
            <li className="muted">灰显列未检测到 agent，相关写操作已禁用</li>
          )}
        </ul>
      </div>

      {loadError && (
        <div className="error">
          刷新失败：{loadError}（显示的是上次扫描结果）
          <button type="button" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}
      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}

      {pending && (
        <div className="confirm">
          <span>
            对 <b>{pending.agentLabel}</b> 的 <code>{pending.name}</code> 执行「{pending.label}」？写前会自动建快照。
          </span>
          <span className="confirm-actions">
            <button type="button" className="primary" onClick={confirm} disabled={busy}>
              {busy ? '执行中…' : '确认'}
            </button>
            <button type="button" onClick={() => setPending(null)} disabled={busy}>
              取消
            </button>
          </span>
        </div>
      )}

      {matrix.agents.length === 0 && <p className="muted">没有配置任何 agent，无法显示 skill 分布。</p>}
      {matrix.rows.length === 0 ? (
        <p className="muted">源目录里还没有 skill。</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">skill</th>
                {matrix.agents.map((agent) => (
                  <th key={agent.key} scope="col" className={agent.detected ? '' : 'undetected'}>
                    {agent.label}
                    <span className="count">
                      {
                        matrix.rows.filter((row) => {
                          const state = row.cells[agent.key]?.state;
                          return state !== undefined && EFFECTIVE.includes(state);
                        }).length
                      }{' '}
                      生效
                    </span>
                    {!agent.detected && <span className="tag">未检测到</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((row) => (
                <tr key={row.name} className={row.inSource ? 'from-source' : 'outside-source'}>
                  <th scope="row">{row.name}</th>
                  {matrix.agents.map((agent) => {
                    const cell = row.cells[agent.key] ?? { state: 'missing' as CellState };
                    const actions = actionsFor(cell, row);
                    return (
                      <td key={agent.key} className={`cell state-${cell.state}`} title={title(cell)}>
                        <span aria-hidden="true">{ICON[cell.state]}</span>
                        {cell.state === 'copy' && cell.hashMatch === false && (
                          <span className="drift" aria-hidden="true">
                            ≠
                          </span>
                        )}
                        <span className="sr-only">{LABEL[cell.state]}</span>
                        {actions.length > 0 && (
                          <span className="cell-actions">
                            {actions.map((entry) => (
                              <button
                                key={entry.action}
                                type="button"
                                disabled={!agent.detected || busy}
                                title={agent.detected ? undefined : '未检测到该 agent，无法执行写操作'}
                                aria-label={
                                  agent.detected ? undefined : `${entry.label}（未检测到该 agent，无法执行写操作）`
                                }
                                onClick={() =>
                                  requestAction({
                                    agent: agent.key,
                                    agentLabel: agent.label,
                                    name: row.name,
                                    action: entry.action,
                                    label: entry.label,
                                  })
                                }
                              >
                                {entry.label}
                              </button>
                            ))}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function title(cell: Cell): string {
  const lines = [LABEL[cell.state]];
  if (cell.state === 'copy') lines.push(cell.hashMatch ? '与源内容一致' : '与源内容不同');
  if (cell.target) lines.push(`目标：${cell.target}`);
  if (cell.path) lines.push(`路径：${cell.path}`);
  return lines.join('\n');
}
