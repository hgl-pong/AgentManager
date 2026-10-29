import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, isAbortError } from '../api.ts';
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

interface PendingAction {
  kind: 'init' | 'align';
  agent?: string;
  label: string;
}

export interface PromptsHandle {
  /** Throw away local edits and reload the last known disk content (the global rescan then refetches). */
  discardAndReload: () => void;
}

export function PromptsView({
  version,
  onChanged,
  onDirtyChange,
  handleRef,
}: {
  version: number;
  onChanged: () => void;
  onDirtyChange: (dirty: boolean) => void;
  handleRef: { current: PromptsHandle | null };
}) {
  const [report, setReport] = useState<PromptsReport | null>(null);
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState<'save' | 'action' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [diskChanged, setDiskChanged] = useState(false);

  const contentRef = useRef('');
  const savedRef = useRef('');
  const diskRef = useRef('');
  const seqRef = useRef(0);

  const applyEditor = useCallback((draft: string, saved: string) => {
    contentRef.current = draft;
    savedRef.current = saved;
    setContent(draft);
    setSavedContent(saved);
  }, []);

  const resetEditor = useCallback(
    (disk: string) => {
      diskRef.current = disk;
      applyEditor(disk, disk);
      setDiskChanged(false);
    },
    [applyEditor],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const seq = ++seqRef.current;
      try {
        const [nextReport, nextContent] = await Promise.all([api.prompts(signal), api.promptContent(signal)]);
        if (seq !== seqRef.current) return;
        setReport(nextReport);
        setError(null);
        setLoadError(null);
        if (contentRef.current !== savedRef.current) {
          // 本地有未保存修改：只刷新报告，绝不覆盖编辑器内容。
          diskRef.current = nextContent.content;
          setDiskChanged(nextContent.content !== savedRef.current);
        } else {
          resetEditor(nextContent.content);
        }
      } catch (reason) {
        if (seq !== seqRef.current || signal?.aborted || isAbortError(reason)) return;
        setLoadError(errorMessage(reason));
      }
    },
    [resetEditor],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, version]);

  useEffect(() => {
    onDirtyChange(content !== savedContent);
  }, [content, savedContent, onDirtyChange]);

  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  useEffect(() => {
    handleRef.current = {
      discardAndReload: () => resetEditor(diskRef.current),
    };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, resetEditor]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (contentRef.current === savedRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  async function confirmAction() {
    if (!pending || busy) return;
    const action = pending;
    setBusy('action');
    setError(null);
    setNotice(null);
    try {
      const result = await api.promptAction({ action: action.kind, agent: action.agent });
      setReport(result.report);
      setPending(null);
      setNotice(`${result.message} · 快照 ${result.snapshotId}`);
      // 写操作已成功；后续刷新由 version 触发的 load 负责，失败只显示为刷新错误。
      onChanged();
    } catch (reason) {
      setNotice(null);
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (busy) return;
    const draft = contentRef.current;
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      const result = await api.savePrompt(draft);
      setReport(result.report);
      diskRef.current = result.content.content;
      if (contentRef.current === draft) {
        resetEditor(result.content.content);
      } else {
        // 保存期间用户继续输入：保留新输入，只把“已保存”基线推进到刚写入磁盘的内容。
        savedRef.current = result.content.content;
        setSavedContent(result.content.content);
        setDiskChanged(false);
      }
      const synced = result.report.targets.filter((target) => target.state === 'synced').length;
      setNotice(`保存成功 · 快照 ${result.snapshotId} · ${synced}/${result.report.targets.length} 个 agent 已同步`);
      onChanged();
    } catch (reason) {
      setNotice(null);
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  }

  async function open(path: string) {
    setNotice(null);
    setError(null);
    try {
      await api.open(path);
    } catch (reason) {
      setNotice(null);
      setError(errorMessage(reason));
    }
  }

  if (!report && loadError) {
    return (
      <div className="error">
        读取失败：{loadError}
        <button type="button" onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  }
  if (!report) return <p className="muted">读取中…</p>;

  const missingSource = !report.source.exists;
  const dirty = content !== savedContent;
  const bytes = new TextEncoder().encode(content).length;

  return (
    <section>
      <div className="toolbar">
        <p className="meta">
          单一源 <code>{report.source.path}</code> · {report.source.exists ? `${report.source.bytes} 字节` : '尚未建立'}
        </p>
      </div>

      {loadError && (
        <div className="error">
          刷新失败：{loadError}（下方是上次读取的数据）
          <button type="button" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}
      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}
      {diskChanged && (
        <p className="warning">
          磁盘上的正文已在别处修改。为避免覆盖你的编辑，编辑器没有重新载入；点「重新扫描」可放弃本地修改并载入磁盘内容。
        </p>
      )}

      {pending && (
        <div className="confirm">
          <span>{pending.label}？写前会自动建快照，原文件可回滚。</span>
          <span className="confirm-actions">
            <button type="button" className="primary" onClick={confirmAction} disabled={busy !== null}>
              {busy === 'action' ? '执行中…' : '确认'}
            </button>
            <button type="button" onClick={() => setPending(null)} disabled={busy !== null}>
              取消
            </button>
          </span>
        </div>
      )}

      <div className="cards">
        <article className="card wide editor-card">
          <header>
            <h2>单一源正文</h2>
            <span className={`tag ${dirty ? 'dirty' : ''}`}>{dirty ? '未保存' : report.source.exists ? '已保存' : '未建立'}</span>
          </header>
          <p className="path">
            <code>{report.source.path}</code>
          </p>
          {missingSource && (
            <p className="muted">
              首次初始化会以 Claude Code 的 CLAUDE.md 内容为准。也可以直接在这里写入，保存后成为唯一正文。
            </p>
          )}
          <label className="sr-only" htmlFor="prompt-source-editor">
            单一源提示词正文
          </label>
          <textarea
            id="prompt-source-editor"
            className="prompt-editor"
            value={content}
            onChange={(event) => {
              contentRef.current = event.target.value;
              setContent(event.target.value);
            }}
            spellCheck={false}
            rows={16}
            placeholder="在这里编辑所有 agent 共享的全局提示词…"
          />
          <div className="editor-actions">
            <span className="meta">
              {bytes} 字节 · {dirty ? '有未保存的修改' : '已与磁盘一致'}
            </span>
            <span className="confirm-actions">
              {report.source.exists && (
                <button type="button" onClick={() => open(report.source.path)}>
                  打开文件
                </button>
              )}
              {missingSource && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy !== null}
                  onClick={() => {
                    setNotice(null);
                    setPending({ kind: 'init', label: '从 CLAUDE.md 初始化单一源并迁移所有 agent' });
                  }}
                >
                  从 CLAUDE.md 初始化
                </button>
              )}
              <button type="button" className="primary" onClick={save} disabled={!dirty || busy !== null}>
                {busy === 'save' ? '保存中…' : '保存并生效'}
              </button>
            </span>
          </div>
          <p className="meta">
            硬链接目标会立即读取新内容；如果是独立副本，保存后会显示「与源不同」，点对应 agent 的「对齐到源」即可。
          </p>
        </article>

        {report.targets.length === 0 && <p className="muted">没有配置任何 agent 的提示词目标。</p>}
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
            {target.target && <p className="meta">→ {target.target}</p>}
            <div className="confirm-actions">
              {target.state !== 'missing' && target.state !== 'no-source' && target.state !== 'broken' && (
                <button type="button" onClick={() => open(target.path)}>
                  打开
                </button>
              )}
              {!missingSource && target.state !== 'synced' && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => {
                    setNotice(null);
                    setPending({ kind: 'align', agent: target.key, label: `让 ${target.label} 的提示词指向单一源` });
                  }}
                >
                  对齐到源
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
