import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, isAbortError } from '../api.ts';
import { useConfirmDialog } from '../lib/confirm.tsx';
import type { SnapshotManifest } from '../../../shared/types.ts';

function formatTime(snapshot: SnapshotManifest): string {
  return new Date(snapshot.createdAt).toLocaleString('zh-CN');
}

export function SnapshotsPanel({ version, onRestored }: { version: number; onRestored: () => void }) {
  const [items, setItems] = useState<SnapshotManifest[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [ask, confirmNode] = useConfirmDialog();
  const seqRef = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const next = await api.snapshots(signal);
      if (seq !== seqRef.current) return;
      setItems(next);
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

  async function restore(snapshot: SnapshotManifest) {
    if (busy) return;
    setRestoreError(null);
    await ask({
      title: '还原到这个快照',
      danger: true,
      message: (
        <>
          <code>{snapshot.id}</code>（{formatTime(snapshot)}，操作：
          <code>{snapshot.operation}</code>）
          <br />
          当前文件会被快照内容覆盖，快照期间新建、之后没有再改动的内容会被删除；快照之后又新建的文件会保留。还原前会自动存一份安全快照。
        </>
      ),
      confirmLabel: '还原',
      // The restore runs inside the dialog so a failure and its retry stay in one place.
      run: async () => {
        setBusy(snapshot.id);
        setNotice(null);
        try {
          const { report, snapshotId } = await api.restore(snapshot.id);
          const safe = snapshotId ? ` · 安全快照 ${snapshotId}` : '';
          const kept = report.kept.length > 0 ? `，保留了 ${report.kept.length} 项快照过后重新出现的内容` : '';
          if (report.missing.length > 0) {
            setNotice(`还原完成但不完整：已还原 ${report.restored.length} 项，移除 ${report.removed.length} 项新建内容${safe}`);
            setRestoreError(
              `${report.missing.length} 项无法还原（快照里没有对应备份）：${report.missing.join('、')}`,
            );
          } else {
            setNotice(`已还原 ${report.restored.length} 项，移除 ${report.removed.length} 项新建内容${kept}${safe}`);
          }
          onRestored();
        } finally {
          setBusy(null);
        }
      },
    });
  }

  return (
    <section className="snapshots">
      <header>
        <button
          type="button"
          className="link-button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? '▾' : '▸'} 快照（{loading && items.length === 0 ? '…' : items.length}）
        </button>
        {notice && <span className="notice inline">{notice}</span>}
      </header>
      {confirmNode}

      {loadError && (
        <div className="error">
          读取快照失败：{loadError}
          {items.length > 0 ? '（显示的是上次读取的列表）' : ''}
          <button type="button" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}
      {restoreError && <p className="error">{restoreError}</p>}

      {open && (
        <>
          {loading && items.length === 0 ? (
            <p className="muted">读取快照…</p>
          ) : loadError && items.length === 0 ? (
            <p className="muted">快照列表暂时读取失败，可重试。</p>
          ) : items.length === 0 ? (
            <p className="muted">还没有快照——第一次写操作时会自动创建。</p>
          ) : (
            <ul className="snapshot-list">
              {items.map((snapshot) => (
                <li key={snapshot.id}>
                  <div>
                    <code>{snapshot.id}</code>
                    <span className="meta">
                      {' '}
                      · <code>{snapshot.operation}</code> · {formatTime(snapshot)} · 备份 {snapshot.entries.length} 项
                      {snapshot.created.length > 0 ? `，新建 ${snapshot.created.length} 项` : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setNotice(null);
                      setRestoreError(null);
                      void restore(snapshot);
                    }}
                    disabled={busy !== null}
                    aria-label={`还原快照 ${snapshot.id}（${formatTime(snapshot)}）`}
                  >
                    {busy === snapshot.id ? '还原中…' : '还原'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
