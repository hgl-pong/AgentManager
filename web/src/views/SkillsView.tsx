import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, errorMessage, isAbortError } from '../api.ts';
import { useConfirmDialog } from '../lib/confirm.tsx';
import { needsAttention } from '../lib/attention.ts';
import type { Cell, CellState, MatrixResponse, Row, SkillActionKind } from '../../../shared/types.ts';

const SHORT: Record<CellState, string> = {
  linked: '链接',
  broken: '坏链',
  external: '外部',
  copy: '副本',
  orphan: '孤儿',
  missing: '缺失',
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
  cell: Cell;
  inSource: boolean;
  /** Incoming and outbound paths, so a dialog for a not-yet-existing link can still name both ends. */
  agentRoot: string;
  sourceRoot: string;
}

/** Each action names the exact thing that changes on disk, so the dialog never needs a manual. */
const CONFIRM: Record<SkillActionKind, { title: string; confirm: string; danger: boolean }> = {
  link: { title: '建立链接', confirm: '建立链接', danger: false },
  import: { title: '收进源并改链接', confirm: '收进源', danger: false },
  remove: { title: '删除这个副本', confirm: '删除副本', danger: true },
  unlink: { title: '移除失效链接', confirm: '移除链接', danger: true },
};

function pathOf(cell: Cell): string | undefined {
  return cell.path ?? cell.target;
}

/** Mirrors the server's own path join: the matrix only carries roots, not per-row paths. */
function joinPath(root: string, name: string): string {
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${separator}${name}`;
}

function describeAction(pending: Pending): ReactNode {
  const { name, agentLabel, action, cell, inSource } = pending;
  const where = pathOf(cell);
  const path = where ? (
    <>
      <br />
      <code>{where}</code>
    </>
  ) : null;
  // "missing" has no path on disk yet, so derive the spot the link would be created in.
  const incoming = joinPath(pending.agentRoot, name);
  const outgoing = joinPath(pending.sourceRoot, name);

  if (action === 'remove') {
    return (
      <>
        将删除 {agentLabel} 目录下的 <code>{name}</code>
        {path}。
        <br />
        {inSource ? (
          <>源目录里的 <code>{name}</code> 不受影响，删除后这一列变回「缺失」，可再点「建链」。</>
        ) : (
          <>这个 skill 不在源目录里，删除后它就不存在了（快照里仍有备份）。</>
        )}
      </>
    );
  }
  if (action === 'unlink') {
    return (
      <>
        将移除 {agentLabel} 目录下失效的链接 <code>{name}</code>
        {path}。链接指向的目录已经不存在，所以不会删除任何 skill 文件。
      </>
    );
  }
  if (action === 'import') {
    return (
      <>
        将把 {agentLabel} 目录下的独立副本 <code>{name}</code>
        {path ?? (
          <>
            <br />
            <code>{incoming}</code>
          </>
        )}{' '}
        移动到源目录，再把原位置改成指向源目录的链接。
        <br />
        之后所有 agent 共用 <code>{outgoing}</code> 这一份内容，请先确认源目录里没有同名 skill。
      </>
    );
  }
  return (
    <>
      将在 {agentLabel} 目录下创建 <code>{name}</code> 的链接：
      <br />
      <code>{incoming}</code>
      <br />
      指向 <code>{outgoing}</code>
      <br />
      不会覆盖任何已有内容，之后对这个 skill 的修改对所有 agent 同时生效。
    </>
  );
}

function actionsFor(cell: Cell, row: Row): { action: SkillActionKind; label: string }[] {
  if (cell.state === 'missing' && row.inSource) return [{ action: 'link', label: '建链' }];
  if (cell.state === 'broken') return [{ action: 'unlink', label: '移除坏链' }];
  if (cell.state === 'copy') return [{ action: 'remove', label: '删除副本' }];
  if (cell.state === 'orphan')
    return [
      { action: 'import', label: '收进源' },
      { action: 'remove', label: '删除' },
    ];
  return [];
}

export function SkillsView({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [matrix, setMatrix] = useState<MatrixResponse | null>(null);
  const [busy, setBusy] = useState(false);
  /** Clicking an agent in the filter bar narrows the matrix to that agent's rows needing work. */
  const [onlyAgent, setOnlyAgent] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ask, confirmNode] = useConfirmDialog();
  const seqRef = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const next = await api.matrix(signal);
      if (seq !== seqRef.current) return;
      setMatrix(next);
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

  function requestAction(next: Pending) {
    setNotice(null);
    void ask({
      title: CONFIRM[next.action].title,
      message: describeAction(next),
      confirmLabel: CONFIRM[next.action].confirm,
      danger: CONFIRM[next.action].danger,
      // The write lives in the dialog, so a failure is reported and retried right where it happened.
      run: async () => {
        setBusy(true);
        setNotice(null);
        try {
          const result = await api.skill({ agent: next.agent, action: next.action, name: next.name });
          setMatrix(result.matrix);
          setNotice(`${result.message} · 快照 ${result.snapshotId}`);
          onChanged();
        } finally {
          setBusy(false);
        }
      },
    });
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

  const perAgent = (agentKey: string) =>
    matrix.rows.filter((row) => {
      const state = row.cells[agentKey]?.state;
      return state !== undefined && EFFECTIVE.includes(state);
    }).length;
  const visibleRows =
    onlyAgent === null
      ? matrix.rows
      : matrix.rows.filter((row) => {
          const cell = row.cells[onlyAgent];
          return cell !== undefined && needsAttention(cell.state);
        });

  return (
    <section>
      <div className="toolbar">
        <p className="meta">
          源 <code>{matrix.source.path}</code> · {matrix.source.skills.length} 个 skill · {matrix.rows.length} 行 ·
          {loading ? ' 扫描中…' : ` 扫描耗时 ${matrix.durationMs}ms`}
        </p>
        <ul className="legend">
          {(Object.keys(LABEL) as CellState[]).map((state) => (
            <li key={state}>
              <span className={`state-swatch state-${state}`} aria-hidden="true" /> {LABEL[state]}
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
      {confirmNode}

      {matrix.agents.length === 0 && <p className="muted">没有配置任何 agent，无法显示 skill 分布。</p>}
      {matrix.rows.length === 0 && (
        <p className="muted">
          源目录里还没有 skill。可以从<a href="#store">技能商店</a>安装一个，或把某个 agent 目录里已有的 skill 复制进源后重新扫描。
        </p>
      )}
      {matrix.agents.some((agent) => agent.detected) && (
        <div className="legend-bar">
          <ul className="legend" aria-label="按 agent 筛选">
            {matrix.agents.map((agent) => {
              const attention = matrix.rows.filter((row) => {
                const cell = row.cells[agent.key];
                return cell !== undefined && needsAttention(cell.state);
              }).length;
              return (
                <li key={agent.key}>
                  <button
                    type="button"
                    className="legend-filter"
                    aria-pressed={onlyAgent === agent.key}
                    title={attention > 0 ? `只看 ${agent.label} 里需处理的 skill` : `${agent.label} 没有需处理的 skill`}
                    disabled={attention === 0}
                    onClick={() => setOnlyAgent((current) => (current === agent.key ? null : agent.key))}
                  >
                    {agent.label}
                    <span className="legend-count">{attention}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {onlyAgent !== null && (
            <button type="button" className="legend-clear" onClick={() => setOnlyAgent(null)}>
              显示全部 {matrix.rows.length} 行
            </button>
          )}
        </div>
      )}
      {matrix.rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">skill</th>
                {matrix.agents.map((agent) => (
                  <th key={agent.key} scope="col" className={agent.detected ? '' : 'undetected'}>
                    {agent.label}
                    <span className="count">
                      {perAgent(agent.key)}{' '}
                      生效
                    </span>
                    {!agent.detected && <span className="tag">未检测到</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.name} className={row.inSource ? 'from-source' : 'outside-source'}>
                  <th scope="row">{row.name}</th>
                  {matrix.agents.map((agent) => {
                    const cell = row.cells[agent.key] ?? { state: 'missing' as CellState };
                    const actions = actionsFor(cell, row);
                    return (
                      <td key={agent.key} className={`cell state-${cell.state}`} title={title(cell)}>
                        <span className="cell-state">{SHORT[cell.state]}</span>
                        {cell.state === 'copy' && cell.hashMatch === false && (
                          <span className="drift" aria-hidden="true">
                            ≠
                          </span>
                        )}
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
                                    cell,
                                    inSource: row.inSource,
                                    agentRoot: agent.root,
                                    sourceRoot: matrix.source.path,
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
