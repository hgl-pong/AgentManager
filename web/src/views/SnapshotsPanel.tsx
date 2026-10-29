import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { SnapshotManifest } from '../../../shared/types.ts';

export function SnapshotsPanel({ version, onRestored }: { version: number; onRestored: () => void }) {
  const [items, setItems] = useState<SnapshotManifest[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .snapshots()
      .then(setItems)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  useEffect(load, [load, version]);

  async function restore(id: string) {
    setBusy(id);
    setError(null);
    try {
      const result = await api.restore(id);
      setNotice(`已还原 ${result.report.restored.length} 项，移除 ${result.report.removed.length} 项新建内容`);
      load();
      onRestored();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="snapshots">
      <header>
        <button type="button" className="link-button" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} 快照（{items.length}）
        </button>
        {notice && <span className="notice inline">{notice}</span>}
      </header>
      {error && <p className="error">{error}</p>}
      {open && (
        <ul className="snapshot-list">
          {items.length === 0 && <li className="muted">还没有快照——第一次写操作时会自动创建。</li>}
          {items.map((snapshot) => (
            <li key={snapshot.id}>
              <div>
                <code>{snapshot.operation}</code>
                <span className="meta">
                  {' '}
                  · {new Date(snapshot.createdAt).toLocaleString('zh-CN')} · 备份 {snapshot.entries.length} 项
                  {snapshot.created.length > 0 ? `，新建 ${snapshot.created.length} 项` : ''}
                </span>
              </div>
              <button type="button" onClick={() => restore(snapshot.id)} disabled={busy === snapshot.id}>
                {busy === snapshot.id ? '还原中…' : '还原'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
