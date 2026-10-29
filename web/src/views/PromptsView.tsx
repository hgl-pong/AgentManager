import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { PromptLink, PromptsReport, PromptState } from '../../../shared/types.ts';

const STATE_LABEL: Record<PromptState, string> = {
  'no-source': '源未建立',
  missing: '文件缺失',
  synced: '与源一致',
  drift: '与源不同',
  broken: '链接失效',
  'external-link': '指向别处',
};

const LINK_LABEL: Record<PromptLink, string> = {
  symlink: '符号链接',
  hardlink: '硬链接',
  copy: '独立副本',
  none: '—',
};

export function PromptsView({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [report, setReport] = useState<PromptsReport | null>(null);
  const [pending, setPending] = useState<{ kind: 'init' | 'align'; agent?: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .prompts()
      .then(setReport)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  useEffect(load, [load, version]);

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.promptAction({ action: pending.kind, agent: pending.agent });
      setReport(result.report);
      setNotice(`${result.message} · 快照 ${result.snapshotId}`);
      setPending(null);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  if (error && !report) return <p className="error">读取失败：{error}</p>;
  if (!report) return <p className="muted">读取中…</p>;

  const missingSource = !report.source.exists;

  return (
    <section>
      <div className="toolbar">
        <p className="meta">
          单一源 <code>{report.source.path}</code> · {report.source.exists ? `${report.source.bytes} 字节` : '尚未建立'}
        </p>
      </div>

      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}

      {pending && (
        <div className="confirm">
          <span>
            {pending.label}？写前会自动建快照，原文件可回滚。
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

      <div className="cards">
        <article className="card">
          <header>
            <h2>单一源</h2>
            <span className="tag">{report.source.exists ? '已建立' : '未建立'}</span>
          </header>
          <p className="path">
            <code>{report.source.path}</code>
          </p>
          {missingSource && (
            <p className="muted">首次初始化会以 Claude Code 的 CLAUDE.md 内容为准，并把两个 agent 的提示词改成指向它。</p>
          )}
          {missingSource && (
            <button
              type="button"
              className="primary"
              onClick={() => setPending({ kind: 'init', label: '初始化单一源并迁移两个 agent 的提示词' })}
            >
              初始化单一源
            </button>
          )}
        </article>

        {report.targets.map((target) => (
          <article className="card" key={target.key}>
            <header>
              <h2>{target.label}</h2>
              <span className={`badge state-${target.state}`}>{STATE_LABEL[target.state]}</span>
            </header>
            <p className="path">
              <code>{target.path}</code>
            </p>
            <p className="meta">
              {target.bytes === undefined ? '无内容' : `${target.bytes} 字节`} · {LINK_LABEL[target.link]}
            </p>
            {!missingSource && target.state !== 'synced' && (
              <button
                type="button"
                onClick={() =>
                  setPending({ kind: 'align', agent: target.key, label: `让 ${target.label} 的提示词指向单一源` })
                }
              >
                对齐到源
              </button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
