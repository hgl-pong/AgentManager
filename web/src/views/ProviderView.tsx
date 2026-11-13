import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { api, errorMessage, isAbortError } from '../api.ts';
import type {
  ModelInfo,
  ModelTargetAgent,
  ProviderModelsReport,
  ProvidersReport,
  ProviderSummary,
} from '../../../shared/types.ts';
import { ModelApplyDialog } from '../components/ModelApplyDialog.tsx';
import { ModelCatalogTable } from '../components/ModelCatalogTable.tsx';
import { ModelImportDialog } from '../components/ModelImportDialog.tsx';
import { useConfirmDialog } from '../lib/confirm.tsx';

interface ProviderForm {
  baseUrl: string;
  apiKey: string;
}

const EMPTY_FORM: ProviderForm = { baseUrl: '', apiKey: '' };

function providerOf(report: ProvidersReport | null, id: string | null): ProviderSummary | null {
  if (!report || !id) return null;
  return report.providers.find((provider) => provider.id === id) ?? null;
}

export function ProviderView({
  version,
  onDirtyChange,
  onSnapshotsChanged,
}: {
  version: number;
  onDirtyChange: (dirty: boolean) => void;
  onSnapshotsChanged: () => void;
}) {
  const [report, setReport] = useState<ProvidersReport | null>(null);
  const [models, setModels] = useState<ProviderModelsReport | null>(null);
  const [targets, setTargets] = useState<ModelTargetAgent[] | null>(null);
  const [applying, setApplying] = useState<ModelInfo | null>(null);
  const [importing, setImporting] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [showKey, setShowKey] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<'load' | 'save' | 'activate' | 'remove' | null>('load');
  const [modelsLoading, setModelsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const seqRef = useRef(0);
  const [ask, confirmNode] = useConfirmDialog();

  const selected = providerOf(report, selectedId);
  const dirty = creating
    ? form.baseUrl.trim() !== '' || form.apiKey.trim() !== ''
    : form.baseUrl.trim() !== (selected?.baseUrl ?? '') || form.apiKey.trim() !== '';

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  const loadModels = useCallback(async (refresh = false, signal?: AbortSignal) => {
    setModelsLoading(true);
    try {
      const next = await api.providerModels(refresh, signal);
      setModels(next);
    } catch (reason) {
      if (signal?.aborted || isAbortError(reason)) return;
      setModels((current) => ({
        source: current?.source ?? '',
        fetchedAt: new Date().toISOString(),
        cached: false,
        error: errorMessage(reason),
        models: [],
        provider: current?.provider ?? null,
      }));
    } finally {
      setModelsLoading(false);
    }
  }, []);

  const applyReport = useCallback(
    (next: ProvidersReport) => {
      setReport(next);
      const active = next.activeId ?? next.providers[0]?.id ?? null;
      setSelectedId(active);
      const provider = providerOf(next, active);
      setForm({ baseUrl: provider?.baseUrl ?? '', apiKey: '' });
      setCreating(provider === null);
      setShowKey(false);
      if (!provider) setModels(null);
    },
    [],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const seq = ++seqRef.current;
      setBusy('load');
      setError(null);
      try {
        const next = await api.providers(signal);
        if (seq !== seqRef.current || signal?.aborted) return;
        applyReport(next);
        void api
          .modelTargets(signal)
          .then((report) => {
            if (!signal?.aborted && seq === seqRef.current) setTargets(report.agents);
          })
          .catch(() => {
            if (!signal?.aborted && seq === seqRef.current) setTargets([]);
          });
        if (next.activeId) await loadModels(false, signal);
        else setModels(null);
      } catch (reason) {
        if (seq !== seqRef.current || signal?.aborted || isAbortError(reason)) return;
        setError(errorMessage(reason));
      } finally {
        if (seq === seqRef.current) setBusy(null);
      }
    },
    [applyReport, loadModels],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, version]);

  /** Switching provider or starting a new form discards the current draft; ask first. */
  function discardThen(action: () => void) {
    if (!dirty) {
      action();
      return;
    }
    void ask({
      title: '放弃 provider 修改？',
      danger: true,
      confirmLabel: '放弃修改',
      message: '当前 provider 表单有未保存的 base URL 或 API key 修改，继续会放弃它们。',
    }).then((discard) => {
      if (discard) action();
    });
  }

  function chooseProvider(provider: ProviderSummary) {
    if (busy !== null || provider.id === selectedId) return;
    discardThen(() => {
      setBusy('activate');
      setError(null);
      setNotice(null);
      void api
        .activateProvider({ id: provider.id })
        .then(async (result) => {
          applyReport(result.report);
          setNotice(result.message);
          setFormError(null);
          setModels(null);
          onSnapshotsChanged();
          await loadModels(true);
        })
        .catch((reason: unknown) => setError(errorMessage(reason)))
        .finally(() => setBusy(null));
    });
  }

  function startCreate() {
    if (busy !== null) return;
    discardThen(() => {
      setCreating(true);
      setSelectedId(null);
      setForm(EMPTY_FORM);
      setShowKey(false);
      setFormError(null);
      setNotice(null);
      setQuery('');
      setModels(null);
    });
  }

  function cancelCreate() {
    if (busy !== null) return;
    discardThen(() => {
      setCreating(false);
      const provider = providerOf(report, report?.activeId ?? null);
      setSelectedId(provider?.id ?? null);
      setForm({ baseUrl: provider?.baseUrl ?? '', apiKey: '' });
      setShowKey(false);
      setFormError(null);
      if (provider) void loadModels(false);
      else setModels(null);
    });
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (busy !== null) return;
    const baseUrl = form.baseUrl.trim();
    if (baseUrl === '') {
      setFormError('填写 provider 的 base URL。');
      return;
    }
    if (creating && form.apiKey.trim() === '') {
      setFormError('新 provider 需要 API key。');
      return;
    }
    setBusy('save');
    setFormError(null);
    setError(null);
    setNotice(null);
    const editingId = creating ? undefined : selected?.id;
    void api
      .saveProvider({
        ...(editingId ? { id: editingId } : {}),
        baseUrl,
        ...(form.apiKey.trim() !== '' ? { apiKey: form.apiKey.trim() } : {}),
      })
      .then(async (result) => {
        applyReport(result.report);
        setNotice(result.message);
        setModels(null);
        onSnapshotsChanged();
        await loadModels(true);
      })
      .catch((reason: unknown) => setFormError(errorMessage(reason)))
      .finally(() => setBusy(null));
  }

  function remove() {
    if (!selected || busy !== null) return;
    setNotice(null);
    setError(null);
    void ask({
      title: `删除 provider ${selected.host}`,
      danger: true,
      confirmLabel: '删除 provider',
      message: (
        <>
          <p>
            将删除 <code>{selected.baseUrl}</code> 及其本地保存的 API key。
          </p>
          {selected.active && <p>它当前是 active provider；删除后会切换到列表里的下一个 provider，没有则回到空白。</p>}
          <p>写入前会建快照，可在快照面板还原。</p>
        </>
      ),
      run: async () => {
        setBusy('remove');
        try {
          const result = await api.removeProvider({ id: selected.id });
          applyReport(result.report);
          setNotice(result.message);
          setModels(null);
          onSnapshotsChanged();
          if (result.report.activeId) await loadModels(true);
        } finally {
          setBusy(null);
        }
      },
    });
  }

  /** Open the import dialog: pick a default model, preview, then write to all agents. */
  function importAll() {
    if (!selected || !models || models.models.length === 0 || !targets || dirty) return;
    setNotice(null);
    setError(null);
    setImporting(true);
  }

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = models?.models ?? [];
    if (needle === '') return list;
    return list.filter((model) => `${model.id} ${model.name} ${model.group}`.toLowerCase().includes(needle));
  }, [models, query]);

  if (!report && error) {
    return (
      <section className="provider-page">
        <div className="error">
          读取 provider 失败：{error}
          <button type="button" onClick={() => void load()}>
            重试
          </button>
        </div>
      </section>
    );
  }
  if (!report) return <p className="muted">读取 provider…</p>;

  return (
    <section className="provider-page">
      {error && (
        <p className="error">
          操作失败：{error}
          <button type="button" onClick={() => void load()}>
            重新读取
          </button>
        </p>
      )}
      {notice && <p className="notice">{notice}</p>}
      {confirmNode}

      <div className="provider-layout">
        <aside className="provider-rail" aria-label="Provider 列表">
          <div className="provider-rail-head">
            <span className="provider-rail-label">Provider</span>
            <span className="provider-rail-count">{report.providers.length}</span>
          </div>
          <div className="provider-list">
            {report.providers.map((provider) => (
              <button
                key={provider.id}
                type="button"
                className={provider.id === selectedId ? 'provider-item is-active' : 'provider-item'}
                disabled={busy !== null}
                title={provider.baseUrl}
                onClick={() => chooseProvider(provider)}
              >
                <span className="provider-item-host">{provider.host}</span>
                <code>{provider.baseUrl}</code>
                <span className="provider-item-state">{provider.active ? '当前' : '切换'}</span>
              </button>
            ))}
          </div>
          <button type="button" className="secondary provider-add" onClick={startCreate} disabled={busy !== null}>
            + 新增 provider
          </button>
          <p className="provider-hint">当前 provider 的模型会出现在设置页的 model 字段里。</p>
        </aside>

        <div className="provider-main">
          <section className="provider-panel">
            <header className="provider-panel-head">
              <div>
                <h2>{creating ? '新增 provider' : selected?.host ?? 'Provider'}</h2>
                <p className="meta">
                  {creating
                    ? '只需要 base URL 和 API key。保存后读取模型。'
                    : 'base URL 与 API key 保存在本机；key 不会回传到页面。'}
                </p>
              </div>
              {!creating && selected && (
                <span className={selected.active ? 'tag tag-active' : 'tag'}>
                  {selected.active ? '当前 provider' : '未激活'}
                </span>
              )}
            </header>

            {formError && <p className="error">{formError}</p>}

            <form className="provider-form" onSubmit={save}>
              <label className="provider-field">
                <span>Base URL</span>
                <input
                  className="control mono-input"
                  type="url"
                  value={form.baseUrl}
                  placeholder="https://api.example.com/v1"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={busy !== null}
                  onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))}
                />
              </label>

              <label className="provider-field">
                <span>API key</span>
                <span className="provider-key-row">
                  <input
                    className="control mono-input"
                    type={showKey ? 'text' : 'password'}
                    value={form.apiKey}
                    placeholder={creating || !selected?.hasApiKey ? '填写 API key' : '已保存 · 留空不修改'}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={busy !== null}
                    onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
                  />
                  <button type="button" className="secondary provider-key-toggle" onClick={() => setShowKey((value) => !value)}>
                    {showKey ? '隐藏' : '显示'}
                  </button>
                </span>
              </label>

              <div className="provider-actions">
                <button type="submit" className="primary" disabled={busy !== null}>
                  {busy === 'save' ? '保存中…' : creating ? '保存并读取模型' : '保存 provider'}
                </button>
                {creating ? (
                  <button type="button" className="secondary" onClick={cancelCreate} disabled={busy !== null}>
                    取消
                  </button>
                ) : (
                  <button type="button" className="danger" onClick={remove} disabled={busy !== null}>
                    {busy === 'remove' ? '删除中…' : '删除 provider'}
                  </button>
                )}
              </div>
            </form>
          </section>

          <section className="provider-panel provider-models">
            <header className="provider-panel-head">
              <div>
                <h2>模型</h2>
                <p className="meta">
                  {selected
                    ? `${selected.host} 返回的可用模型；设置页的 model 字段从这里取候选。`
                    : '保存并激活一个 provider 后读取模型。'}
                </p>
              </div>
              <div className="provider-model-actions">
                {models && models.models.length > 0 && (
                  <input
                    className="control provider-model-search"
                    type="search"
                    value={query}
                    placeholder="筛选 ID、名称或分组"
                    aria-label="筛选模型"
                    spellCheck={false}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                )}
                <button
                  type="button"
                  className="secondary"
                  disabled={!selected || modelsLoading || dirty}
                  title={dirty ? '先保存 provider 修改' : undefined}
                  onClick={() => void loadModels(true)}
                >
                  {modelsLoading ? '读取中…' : '读取模型'}
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={!selected || !models || models.models.length === 0 || dirty || !targets || targets.length === 0}
                  title={
                    dirty
                      ? '先保存 provider 修改'
                      : !models || models.models.length === 0
                        ? '先读取模型'
                        : `把全部 ${models.models.length} 个模型写入所有 agent`
                  }
                  onClick={() => void importAll()}
                >
                  导入全部
                </button>
              </div>
            </header>

            {models && (
              <p className="provider-model-status">
                <span>
                  来源 <code>{models.source || '—'}</code>
                </span>
                {models.provider && <span className="meta">{models.provider.host}</span>}
                <span className="meta">{models.models.length} 个模型</span>
                {models.fetchedAt && (
                  <span className="meta">更新于 {new Date(models.fetchedAt).toLocaleTimeString()}</span>
                )}
                {models.cached && <span className="meta">缓存</span>}
                {models.stale && <span className="meta">端点不可用，显示上次结果</span>}
              </p>
            )}
            {models?.error && <p className="error">模型读取失败：{models.error}</p>}
            {modelsLoading && !models && <p className="muted">读取模型…</p>}
            {selected && models && models.models.length === 0 && !models.error && (
              <p className="muted">这个 provider 没有返回模型。检查 base URL，或点「读取模型」重试。</p>
            )}
            {selected && !models && !modelsLoading && (
              <p className="muted">还没有读取模型。点「读取模型」开始。</p>
            )}
            {!selected && <p className="muted">先保存并激活一个 provider。</p>}

            {dirty && selected && (
              <p className="hint">保存 provider 修改后可以把模型应用到 agent。</p>
            )}

            {selected && models && models.models.length > 0 && (
              <ModelCatalogTable
                models={filtered}
                onApply={
                  !dirty && targets && targets.length > 0
                    ? (model) => setApplying(model)
                    : undefined
                }
              />
            )}
          </section>
        </div>
      </div>

      {applying && selected && targets && (
        <ModelApplyDialog
          model={applying}
          provider={selected}
          targets={targets}
          onClose={() => setApplying(null)}
          onApplied={(result) => {
            setApplying(null);
            setNotice(
              result.snapshotIds.length > 0
                ? `${result.message} · 快照 ${result.snapshotIds.join('、')}`
                : result.message,
            );
            onSnapshotsChanged();
          }}
        />
      )}

      {importing && selected && models && targets && (
        <ModelImportDialog
          models={models.models}
          provider={selected}
          targets={targets}
          onClose={() => setImporting(false)}
          onApplied={(result) => {
            setImporting(false);
            setNotice(
              result.snapshotIds.length > 0
                ? `${result.message} · 快照 ${result.snapshotIds.join('、')}`
                : result.message,
            );
            onSnapshotsChanged();
          }}
        />
      )}
    </section>
  );
}
