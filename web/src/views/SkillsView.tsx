import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
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

interface Pending {
  agent: string;
  agentLabel: string;
  name: string;
  action: SkillActionKind;
  label: string;
}

function actionsFor(cell: Cell, row: Row): { action: SkillActionKind; label: string }[] {
  if (cell.state === 'missing' && row.inSource) return [{ action: 'link', label: '建链' }];
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

  const load = useCallback(() => {
    setError(null);
    api
      .matrix()
      .then(setMatrix)
      .catch((reason: unknown) => setError(String(reason instanceof Error ? reason.message : reason)));
  }, []);

  useEffect(load, [load, version]);

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.skill({ agent: pending.agent, action: pending.action, name: pending.name });
      setMatrix(result.matrix);
      setNotice(`${result.message} · 快照 ${result.snapshotId}`);
      setPending(null);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  if (error && !matrix) return <p className="error">扫描失败：{error}</p>;
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
        </ul>
      </div>

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

      <table>
        <thead>
          <tr>
            <th scope="col">skill</th>
            {matrix.agents.map((agent) => (
              <th key={agent.key} scope="col" className={agent.detected ? '' : 'undetected'}>
                {agent.label}
                <span className="count">
                  {matrix.rows.filter((row) => ['linked', 'copy'].includes(row.cells[agent.key]?.state ?? '')).length} 生效
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
                            onClick={() =>
                              setPending({
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
