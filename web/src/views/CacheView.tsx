import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage, isAbortError } from '../api.ts';
import { useConfirmDialog } from '../lib/confirm.tsx';
import type { CacheBucket, CacheRecycleItem, CacheReport, CacheTargetReport } from '../../../shared/types.ts';

/** Range options for a clean; 0 means the whole target. Order matches the server's buckets. */
const AGE_OPTIONS = [
  { days: 1, label: '1 天前的文件' },
  { days: 7, label: '7 天前的文件' },
  { days: 30, label: '30 天前的文件' },
  { days: 90, label: '90 天前的文件' },
  { days: 0, label: '全部文件' },
] as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index] ?? 'TB'}`;
}

function formatTime(iso: string | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** What the selected age range covers for one target; `days = 0` is the whole target. */
function scopeOf(target: CacheTargetReport, days: number): CacheBucket {
  if (days === 0) return { days, bytes: target.bytes, files: target.files };
  return target.buckets.find((bucket) => bucket.days === days) ?? { days, bytes: 0, files: 0 };
}

function scopeLabel(days: number): string {
  return days === 0 ? '全部内容' : `${days} 天前的文件`;
}

/** Short form for the size cell, where the sentence around it already says "其中". */
function scopeShort(days: number): string {
  return days === 0 ? '全部' : `${days} 天前`;
}

export function CacheView({ version }: { version: number }) {
  const [report, setReport] = useState<CacheReport | null>(null);
  // Whole targets by default: this page exists to show where the gigabytes are, and every clean is
  // confirmed with a size and can be undone, so "older than N days" is the opt-in, not the default.
  const [ageDays, setAgeDays] = useState<number>(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [recycleOpen, setRecycleOpen] = useState(false);
  const [ask, confirmNode] = useConfirmDialog();
  const seqRef = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const seq = ++seqRef.current;
    try {
      const next = await api.cache(signal);
      if (seq !== seqRef.current) return;
      setReport(next);
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

  async function open(path: string) {
    setActionError(null);
    try {
      await api.open(path);
    } catch (reason) {
      setActionError(errorMessage(reason));
    }
  }

  /** "clean:id1,id2" so a row or a whole agent group can show its own progress. */
  const cleanKey = (targets: CacheTargetReport[]) => `clean:${targets.map((target) => target.id).join(',')}`;

  /** One or many targets move in a single recycle item, so a whole agent group is one undo step. */
  function requestClean(targets: CacheTargetReport[]) {
    const picked = targets
      .map((target) => ({ target, scope: scopeOf(target, ageDays) }))
      .filter((entry) => entry.scope.files > 0);
    if (picked.length === 0) return;

    const files = picked.reduce((total, entry) => total + entry.scope.files, 0);
    const bytes = picked.reduce((total, entry) => total + entry.scope.bytes, 0);
    const history = picked.filter((entry) => entry.target.risk === 'history');
    const single = picked.length === 1 ? picked[0] : undefined;
    setNotice(null);
    setActionError(null);

    void ask({
      title: single ? '清理缓存' : `清理 ${picked[0]?.target.agentLabel ?? ''} 的缓存`,
      danger: true,
      message: (
        <>
          {single ? (
            <p>
              将把 <code>{single.target.path}</code> 里{scopeLabel(ageDays)}（{single.scope.files} 个文件，
              {formatBytes(single.scope.bytes)}）移到回收站。
            </p>
          ) : (
            <>
              <p>
                将把这些位置里{scopeLabel(ageDays)}（{files} 个文件，{formatBytes(bytes)}）移到回收站：
              </p>
              <ul className="cache-clean-list">
                {picked.map((entry) => (
                  <li key={entry.target.id}>
                    <code>{entry.target.path}</code>
                    <span className="meta">
                      {' '}
                      —— {entry.scope.files} 个文件，{formatBytes(entry.scope.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {single?.target.note && <p className="muted">{single.target.note}</p>}
          {history.length > 0 && (
            <p className="muted">
              其中 {history.map((entry) => entry.target.label).join('、')} 含对话记录：清理后这些会话无法再回看，
              直到在回收站里恢复。
            </p>
          )}
          <p>清理只是移动文件，本页「回收站」里可以原样恢复；彻底删除需要另外确认。</p>
        </>
      ),
      confirmLabel: '移到回收站',
      run: async () => {
        const key = cleanKey(picked.map((entry) => entry.target));
        setBusy(key);
        try {
          const result = await api.cacheAction({
            action: 'clean',
            ids: picked.map((entry) => entry.target.id),
            olderThanDays: ageDays,
          });
          setReport(result.report);
          setNotice(result.message);
          if ((result.movedFiles ?? 0) > 0) setRecycleOpen(true);
        } finally {
          setBusy(null);
        }
      },
    });
  }

  function restoreItem(item: CacheRecycleItem) {
    setNotice(null);
    setActionError(null);
    void ask({
      title: '恢复回收站内容',
      message: (
        <>
          把 <code>{item.id}</code> 里的 {item.files} 个文件（{formatBytes(item.bytes)}）放回原来的位置。
          <br />
          原位置已经有同名内容的文件会留在回收站，不会被覆盖。
        </>
      ),
      confirmLabel: '恢复',
      run: async () => {
        setBusy(`restore:${item.id}`);
        try {
          const result = await api.cacheAction({ action: 'restore', recycleIds: [item.id] });
          setReport(result.report);
          setNotice(result.message);
          if (result.skipped && result.skipped.length > 0) setActionError(`未恢复：${result.skipped.join('、')}`);
        } finally {
          setBusy(null);
        }
      },
    });
  }

  function purgeItem(item: CacheRecycleItem) {
    setNotice(null);
    setActionError(null);
    void ask({
      title: '彻底删除',
      danger: true,
      message: (
        <>
          将永久删除 <code>{item.id}</code> 里的 {item.files} 个文件（{formatBytes(item.bytes)}）。
          <br />
          这一步没有快照，删除后无法恢复。
        </>
      ),
      confirmLabel: '永久删除',
      run: async () => {
        setBusy(`purge:${item.id}`);
        try {
          const result = await api.cacheAction({ action: 'purge', recycleIds: [item.id] });
          setReport(result.report);
          setNotice(result.message);
        } finally {
          setBusy(null);
        }
      },
    });
  }

  function purgeAll(items: CacheRecycleItem[]) {
    const bytes = items.reduce((total, item) => total + item.bytes, 0);
    const files = items.reduce((total, item) => total + item.files, 0);
    setNotice(null);
    setActionError(null);
    void ask({
      title: '清空回收站',
      danger: true,
      message: (
        <>
          将永久删除回收站里的 {items.length} 项（{files} 个文件，{formatBytes(bytes)}）。
          <br />
          <code>{report?.recycle.path}</code> 会被清空，删除后无法恢复。
        </>
      ),
      confirmLabel: '清空并释放空间',
      run: async () => {
        setBusy('purge:all');
        try {
          const result = await api.cacheAction({ action: 'purge' });
          setReport(result.report);
          setNotice(result.message);
        } finally {
          setBusy(null);
        }
      },
    });
  }

  const present = useMemo(
    () => (report?.targets ?? []).filter((target) => target.exists && target.files > 0),
    [report],
  );
  const emptyCount = (report?.targets ?? []).length - present.length;
  const totals = useMemo(
    () =>
      present.reduce(
        (sum, target) => ({ bytes: sum.bytes + target.bytes, files: sum.files + target.files }),
        { bytes: 0, files: 0 },
      ),
    [present],
  );

  /** One section per agent: sizes only make sense when you know whose directory they are. */
  const groups = useMemo(() => {
    const order: string[] = [];
    const byAgent = new Map<string, { key: string; label: string; targets: CacheTargetReport[]; bytes: number; files: number; scope: CacheBucket }>();
    for (const target of present) {
      let group = byAgent.get(target.agent);
      if (!group) {
        group = {
          key: target.agent,
          label: target.agentLabel,
          targets: [],
          bytes: 0,
          files: 0,
          scope: { days: ageDays, bytes: 0, files: 0 },
        };
        byAgent.set(target.agent, group);
        order.push(target.agent);
      }
      group.targets.push(target);
      group.bytes += target.bytes;
      group.files += target.files;
      const scope = scopeOf(target, ageDays);
      group.scope.bytes += scope.bytes;
      group.scope.files += scope.files;
    }
    return order.map((key) => byAgent.get(key)).filter((group) => group !== undefined);
  }, [present, ageDays]);

  if (!report && loadError) {
    return (
      <div className="error">
        扫描缓存失败：{loadError}
        <button type="button" onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  }
  if (!report) return <p className="muted">扫描缓存占用…</p>;

  return (
    <section>
      <div className="toolbar">
        <p className="meta">
          缓存合计 <strong>{formatBytes(totals.bytes)}</strong>（{totals.files} 个文件） · 回收站{' '}
          {formatBytes(report.recycle.bytes)}（{report.recycle.items.length} 项） · 扫描耗时 {report.durationMs}ms
        </p>
        <label className="meta cache-filter">
          清理范围
          <select
            className="control"
            value={ageDays}
            onChange={(event) => setAgeDays(Number(event.target.value))}
            aria-label="清理范围"
          >
            {AGE_OPTIONS.map((option) => (
              <option key={option.days} value={option.days}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
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
      {actionError && <p className="error">{actionError}</p>}
      {confirmNode}

      {present.length === 0 ? (
        <p className="muted">
          本机没有发现已知的缓存目录。如果刚清理过，它们会在 agent 下次写入时重新出现。
        </p>
      ) : (
        <div className="table-wrap">
          <table className="cache-table">
            <thead>
              <tr>
                <th scope="col">位置</th>
                <th scope="col">占用</th>
                {ageDays !== 0 && <th scope="col">{scopeShort(ageDays)}</th>}
                <th scope="col">最近写入</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            {groups.map((group) => {
              const groupKey = cleanKey(group.targets);
              return (
                <tbody key={group.key} className={`cache-group agent-${group.key}`}>
                  <tr className="cache-group-row">
                    <th scope="rowgroup">
                      <span className={`cache-agent agent-${group.key}`}>{group.label}</span>
                      <span className="cache-scope">{group.targets.length} 个位置</span>
                    </th>
                    <td>
                      <span className="cache-bytes">{formatBytes(group.bytes)}</span>
                      <div className="cache-scope">{group.files.toLocaleString('zh-CN')} 个文件</div>
                    </td>
                    {ageDays !== 0 && (
                      <td>
                        <span className="cache-bytes">{formatBytes(group.scope.bytes)}</span>
                        <div className="cache-scope">{group.scope.files.toLocaleString('zh-CN')} 个文件</div>
                      </td>
                    )}
                    <td>—</td>
                    <td>
                      <span className="cell-actions">
                        <button
                          type="button"
                          disabled={busy !== null || group.scope.files === 0}
                          title={
                            group.scope.files === 0
                              ? '所选范围没有文件：换一个清理范围，或选「全部文件」'
                              : `清理 ${group.label} 的 ${group.scope.files} 个文件`
                          }
                          onClick={() => requestClean(group.targets)}
                        >
                          {busy === groupKey ? '清理中…' : '清理本组'}
                        </button>
                      </span>
                    </td>
                  </tr>
                  {group.targets.map((target) => {
                    const scope = scopeOf(target, ageDays);
                    const working = busy === cleanKey([target]);
                    return (
                      <tr key={target.id}>
                        <th scope="row">
                          <span className="cache-label" title={target.note || undefined}>
                            {target.label}
                          </span>{' '}
                          {target.risk === 'history' ? (
                            <span className="tag tag-executable" title="包含对话内容，清理后无法回看这些会话">
                              含对话
                            </span>
                          ) : (
                            <span className="tag">可重建</span>
                          )}
                          <div className="cache-path">{target.path}</div>
                          {target.risk === 'history' && target.note ? (
                            <div className="cache-note">{target.note}</div>
                          ) : null}
                          {target.error && <div className="error">读取失败：{target.error}</div>}
                        </th>
                        <td>
                          <span className="cache-bytes">{formatBytes(target.bytes)}</span>
                          <div className="cache-scope">{target.files.toLocaleString('zh-CN')} 个文件</div>
                        </td>
                        {ageDays !== 0 && (
                          <td>
                            <span className="cache-bytes">{formatBytes(scope.bytes)}</span>
                            <div className="cache-scope">{scope.files.toLocaleString('zh-CN')} 个文件</div>
                          </td>
                        )}
                        <td>{formatTime(target.newest)}</td>
                        <td>
                          <span className="cell-actions">
                            <button
                              type="button"
                              disabled={busy !== null || scope.files === 0}
                              title={
                                scope.files === 0
                                  ? '所选范围没有文件：换一个清理范围，或选「全部文件」'
                                  : undefined
                              }
                              aria-label={`清理 ${target.agentLabel} 的${target.label}（${scope.files} 个文件）`}
                              onClick={() => requestClean([target])}
                            >
                              {working ? '清理中…' : '清理'}
                            </button>
                            <button type="button" onClick={() => void open(target.openPath)}>
                              打开
                            </button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              );
            })}
          </table>
        </div>
      )}

      {emptyCount > 0 && (
        <p className="muted">另有 {emptyCount} 个已知缓存位置为空或不存在，未列出。</p>
      )}

      <section className="snapshots">
        <header>
          <button
            type="button"
            className="link-button"
            aria-expanded={recycleOpen}
            onClick={() => setRecycleOpen(!recycleOpen)}
          >
            {recycleOpen ? '▾' : '▸'} 回收站（{report.recycle.items.length} 项 · {formatBytes(report.recycle.bytes)}）
          </button>
          <span className="meta">
            清理的内容先放在 <code>{report.recycle.path}</code>
          </span>
          {report.recycle.items.length > 0 && (
            <button
              type="button"
              className="danger"
              disabled={busy !== null}
              onClick={() => purgeAll(report.recycle.items)}
            >
              {busy === 'purge:all' ? '清空中…' : '清空回收站'}
            </button>
          )}
        </header>

        {recycleOpen &&
          (report.recycle.items.length === 0 ? (
            <p className="muted">回收站是空的。清理过的内容会出现在这里，直到彻底删除。</p>
          ) : (
            <ul className="snapshot-list">
              {report.recycle.items.map((item) => (
                <li key={item.id}>
                  <div>
                    <code>{item.id}</code>
                    <span className="meta">
                      {' '}
                      · {item.operation} · {formatTime(item.createdAt)} · {item.files} 个文件 ·{' '}
                      {formatBytes(item.bytes)}
                    </span>
                  </div>
                  <span className="cell-actions">
                    <button
                      type="button"
                      disabled={busy !== null}
                      aria-label={`恢复 ${item.id}`}
                      onClick={() => restoreItem(item)}
                    >
                      {busy === `restore:${item.id}` ? '恢复中…' : '恢复'}
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null}
                      aria-label={`彻底删除 ${item.id}`}
                      onClick={() => purgeItem(item)}
                    >
                      {busy === `purge:${item.id}` ? '删除中…' : '彻底删除'}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ))}
      </section>
    </section>
  );
}