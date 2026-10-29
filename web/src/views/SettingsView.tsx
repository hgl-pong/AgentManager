import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { ConfigReport } from '../../../shared/types.ts';

export function SettingsView({ version }: { version: number }) {
  const [report, setReport] = useState<ConfigReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .config()
      .then(setReport)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  useEffect(load, [load, version]);

  if (error && !report) return <p className="error">读取失败：{error}</p>;
  if (!report) return <p className="muted">读取中…</p>;

  const agents = [...new Map(report.files.map((file) => [file.agent, file.label])).entries()];

  async function open(path: string) {
    try {
      await api.open(path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <section>
      <div className="toolbar">
        <p className="meta">只读对比：这里不会写任何配置文件，改动请点「打开」交给编辑器。密钥类字段在页面上已打码。</p>
      </div>

      {error && <p className="error">{error}</p>}

      <h2 className="section-title">MCP server 分布</h2>
      {report.servers.length === 0 ? (
        <p className="muted">没有发现 MCP server。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">server</th>
              {agents.map(([key, label]) => (
                <th key={key} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.servers.map((row) => (
              <tr key={row.name}>
                <th scope="row">{row.name}</th>
                {agents.map(([key]) => {
                  const cells = row.byAgent[key] ?? [];
                  return (
                    <td
                      key={key}
                      className={`cell ${cells.length > 0 ? 'state-linked' : 'state-missing'}`}
                      title={cells.map((cell) => `${cell.file}\n${cell.summary}`).join('\n\n')}
                    >
                      {cells.length === 0 ? '—' : `✓${cells.length > 1 ? ` ×${cells.length}` : ''}`}
                      {cells[0] && <span className="cell-note">{cells[0].summary}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="section-title">配置文件</h2>
      <div className="cards">
        {report.files.map((file) => (
          <article className="card" key={file.path}>
            <header>
              <h2>{file.label}</h2>
              <span className="tag">{file.role}</span>
            </header>
            <p className="path">
              <code>{file.path}</code>
            </p>
            <p className="meta">
              {file.exists ? `${file.bytes} 字节 · ${file.format.toUpperCase()}` : '不存在'}
              {file.error ? ` · 解析失败：${file.error}` : ''}
            </p>
            {file.mcpKeys.length > 0 && (
              <p className="meta">
                MCP：{file.mcpKeys.join('、')}
              </p>
            )}
            {file.keys.length > 0 && (
              <ul className="keys">
                {file.keys.slice(0, 12).map((entry) => (
                  <li key={entry.key}>
                    <code>{entry.key}</code>
                    <span>{entry.preview}</span>
                  </li>
                ))}
                {file.keys.length > 12 && <li className="muted">还有 {file.keys.length - 12} 个键…</li>}
              </ul>
            )}
            {file.exists && (
              <button type="button" onClick={() => open(file.path)}>
                打开
              </button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
