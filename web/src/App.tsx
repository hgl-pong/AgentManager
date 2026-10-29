import { useCallback, useEffect, useState } from 'react';
import type { Cell, CellState, MatrixResponse, Row } from '../../shared/types.ts';

const CELL_ICON: Record<CellState, string> = {
  linked: '🔗',
  broken: '🔗✗',
  external: '🔗↗',
  copy: '📄',
  orphan: '⚠',
  missing: '—',
};

const CELL_LABEL: Record<CellState, string> = {
  linked: '已链接',
  broken: '链接失效',
  external: '外部链接',
  copy: '副本',
  orphan: '孤儿',
  missing: '缺失',
};

function cellTitle(cell: Cell): string {
  const lines = [CELL_LABEL[cell.state]];
  if (cell.state === 'copy') lines.push(cell.hashMatch ? '与源内容一致' : '与源内容不同');
  if (cell.target) lines.push(`目标：${cell.target}`);
  if (cell.path) lines.push(`路径：${cell.path}`);
  return lines.join('\n');
}

function CellView({ cell }: { cell: Cell }) {
  return (
    <td className={`cell state-${cell.state}`} title={cellTitle(cell)}>
      <span aria-hidden="true">{CELL_ICON[cell.state]}</span>
      {cell.state === 'copy' && cell.hashMatch === false && (
        <span className="drift" aria-hidden="true">
          ≠
        </span>
      )}
      <span className="sr-only">{CELL_LABEL[cell.state]}</span>
    </td>
  );
}

function RowView({ row, agents }: { row: Row; agents: MatrixResponse['agents'] }) {
  return (
    <tr className={row.inSource ? 'from-source' : 'outside-source'}>
      <th scope="row">{row.name}</th>
      {agents.map((agent) => (
        <CellView key={agent.key} cell={row.cells[agent.key] ?? { state: 'missing' }} />
      ))}
    </tr>
  );
}

async function fetchMatrix(): Promise<MatrixResponse> {
  const response = await fetch('/api/matrix');
  if (!response.ok) throw new Error(`API 返回 ${response.status}`);
  return (await response.json()) as MatrixResponse;
}

export default function App() {
  const [matrix, setMatrix] = useState<MatrixResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    fetchMatrix()
      .then(setMatrix)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  useEffect(load, [load]);

  if (error) {
    return (
      <main>
        <h1>skills 总览</h1>
        <div className="error">
          <p>扫描失败：{error}</p>
          <button type="button" onClick={load}>
            重试
          </button>
        </div>
      </main>
    );
  }

  if (!matrix) {
    return (
      <main>
        <h1>skills 总览</h1>
        <p className="muted">扫描中…</p>
      </main>
    );
  }

  const active = (agent: string) =>
    matrix.rows.filter((row) => ['linked', 'copy'].includes(row.cells[agent]?.state ?? '')).length;

  return (
    <main>
      <header>
        <div>
          <h1>skills 总览</h1>
          <p className="meta">
            源 <code>{matrix.source.path}</code> · {matrix.source.skills.length} 个 skill · {matrix.rows.length} 行 ·
            扫描耗时 {matrix.durationMs}ms
          </p>
        </div>
        <ul className="legend">
          {(Object.keys(CELL_LABEL) as CellState[]).map((state) => (
            <li key={state} className={`state-${state}`}>
              <span aria-hidden="true">{CELL_ICON[state]}</span> {CELL_LABEL[state]}
            </li>
          ))}
          <li>
            <span aria-hidden="true">≠</span> 副本与源不同
          </li>
        </ul>
      </header>

      <table>
        <thead>
          <tr>
            <th scope="col">skill</th>
            {matrix.agents.map((agent) => (
              <th key={agent.key} scope="col" className={agent.detected ? '' : 'undetected'}>
                {agent.label}
                <span className="count">{active(agent.key)} 生效</span>
                {!agent.detected && <span className="tag">未检测到</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((row) => (
            <RowView key={row.name} row={row} agents={matrix.agents} />
          ))}
        </tbody>
      </table>
    </main>
  );
}
