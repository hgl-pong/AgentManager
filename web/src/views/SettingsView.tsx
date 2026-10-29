import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { HttpError, api, errorMessage, isAbortError } from '../api.ts';
import type {
  ModelInfo,
  ModelsReport,
  SettingsAgentCatalog,
  SettingsCatalog,
  SettingsField,
  SettingsFileState,
  SettingsReport,
  SettingsSection,
} from '../../../shared/types.ts';
import {
  CustomKeyPanel,
  FieldList,
  UnknownKeysBlock,
  fieldMatches,
  type FieldApi,
} from '../components/FieldEditor.tsx';
import { McpEditor } from '../components/McpEditor.tsx';
import { RawEditor } from '../components/RawEditor.tsx';
import {
  asObject,
  clone,
  collectFieldErrors,
  collectSensitivePaths,
  deepEqual,
  deleteAt,
  errorText,
  getAt,
  isRecord,
  isSetValue,
  parseSettingsText,
  pathLabel,
  serializeSettingsText,
  setAt,
  validateMcpServers,
  type JsonEntry,
  type JsonObject,
} from '../lib/settings.ts';

type DraftMode = 'form' | 'raw';

interface FileDraft {
  file: SettingsFileState;
  data: JsonObject;
  baseline: JsonObject;
  rawText: string;
  baselineText: string;
  mode: DraftMode;
  json: Record<string, JsonEntry>;
  conflict: string | null;
  error: string | null;
  notice: string | null;
}

interface FileIssues {
  fields: Map<string, string>;
  mcp: Map<string, string>;
  json: Array<{ label: string; error: string }>;
  rawError: string | null;
  count: number;
}

type Nav =
  | { kind: 'models' }
  | { kind: 'common' }
  | { kind: 'section'; key: string }
  | { kind: 'mcp' }
  | { kind: 'raw' };

export interface SettingsHandle {
  /** Drops every local edit (the app already asked the user before calling this). */
  discardAll: () => void;
}

const EMPTY_ERRORS = new Map<string, string>();

/** Top-level string fields that hold a model ID and should offer the fetched list. */
function modelPathsFor(agentKey: string): Set<string> {
  if (agentKey === 'claude') return new Set(['model', 'advisorModel']);
  if (agentKey === 'codex') return new Set(['model', 'review_model']);
  if (agentKey === 'pi') return new Set(['defaultModel']);
  return new Set();
}

function formatTokens(value: number | undefined): string {
  if (!value || value <= 0) return '';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

function compactPath(value: string): string {
  return value.replace(/^[A-Za-z]:\\Users\\[^\\]+\\(?=\.)/i, '~\\');
}

function modelMeta(model: ModelInfo | undefined): string {
  if (!model) return '';
  const parts: string[] = [];
  if (model.contextWindow) parts.push(`上下文 ${formatTokens(model.contextWindow)}`);
  if (model.maxOutputTokens) parts.push(`输出 ${formatTokens(model.maxOutputTokens)}`);
  if (model.thinking) parts.push('thinking');
  if (model.effort) parts.push('effort');
  if (model.imageInput) parts.push('图片');
  if (model.pdfInput) parts.push('PDF');
  return parts.join(' · ');
}

interface ModelTarget {
  agentKey: string;
  agentLabel: string;
  file: SettingsFileState;
  draft: FileDraft;
  path: string[];
  label: string;
  value: string;
  secondary?: string;
  note?: string;
}

function toDraft(file: SettingsFileState, requestedMode?: DraftMode): FileDraft {
  const data = asObject(file.data);
  const text = typeof file.text === 'string' ? file.text : '';
  const mode: DraftMode = file.parseError ? 'raw' : (requestedMode ?? 'form');
  return {
    file,
    data: clone(data),
    baseline: clone(data),
    rawText: text,
    baselineText: text,
    mode,
    json: {},
    conflict: null,
    error: null,
    notice: null,
  };
}

function draftDirty(draft: FileDraft): boolean {
  if (draft.mode === 'raw') return draft.rawText !== draft.baselineText;
  return !deepEqual(draft.data, draft.baseline);
}

function draftChanged(draft: FileDraft): boolean {
  return draftDirty(draft) || Object.keys(draft.json).length > 0 || draft.conflict !== null;
}

function mergeDrafts(
  previous: Record<string, FileDraft>,
  report: SettingsReport,
): Record<string, FileDraft> {
  const next: Record<string, FileDraft> = {};
  for (const agent of report.agents) {
    for (const file of agent.files) {
      const existing = previous[file.id];
      next[file.id] = existing && draftChanged(existing) ? existing : toDraft(file);
    }
  }
  return next;
}

function uniqueFields(fields: SettingsField[]): SettingsField[] {
  const seen = new Set<string>();
  return fields.filter((field) => {
    if (seen.has(field.key)) return false;
    seen.add(field.key);
    return true;
  });
}

function filesOf(report: SettingsReport | null, agentKey: string): SettingsFileState[] {
  return report?.agents.find((agent) => agent.key === agentKey)?.files ?? [];
}

function pickPrimaryFile(
  agent: SettingsAgentCatalog,
  files: SettingsFileState[],
): SettingsFileState | undefined {
  return (
    files.find((file) => file.id === `${agent.key}-settings`) ??
    files.find((file) => file.id === `${agent.key}-config`) ??
    files.find((file) => file.scope === 'full' && file.role.includes('设置')) ??
    files.find((file) => file.scope === 'full') ??
    files[0]
  );
}

function mcpMapFor(draft: FileDraft, agent: SettingsAgentCatalog): JsonObject {
  if (draft.file.scope === 'mcp') return asObject(draft.data);
  return asObject(getAt(draft.data, [agent.mcp.key]));
}

interface FlagChanges {
  managedOnly: string[];
  executable: string[];
}

/**
 * Lists catalog fields whose value differs from the loaded baseline. Only the primary
 * settings file is compared: the same catalog does not describe the separate MCP files.
 */
function collectFlagChanges(
  catalog: SettingsCatalog,
  report: SettingsReport,
  drafts: Record<string, FileDraft>,
): FlagChanges {
  const managedOnly = new Set<string>();
  const executable = new Set<string>();

  function walk(
    fields: SettingsField[],
    base: string[],
    fileLabel: string,
    current: JsonObject,
    baseline: JsonObject,
  ): void {
    for (const field of fields) {
      const path = [...base, field.key];
      if (field.managedOnly || field.executable) {
        const before = getAt(baseline, path);
        const after = getAt(current, path);
        if (!deepEqual(before, after)) {
          const label = `${fileLabel} · ${pathLabel(path)}`;
          if (field.managedOnly) managedOnly.add(label);
          if (field.executable) executable.add(label);
        }
      }
      if (field.fields && field.fields.length > 0) {
        walk(field.fields, path, fileLabel, current, baseline);
      }
    }
  }

  for (const draft of Object.values(drafts)) {
    if (!draftChanged(draft)) continue;
    const agent = catalog.agents.find((entry) => entry.key === draft.file.agent);
    if (!agent) continue;
    const primary = pickPrimaryFile(agent, filesOf(report, agent.key));
    if (!primary || primary.id !== draft.file.id) continue;

    let current: JsonObject;
    if (draft.mode === 'raw') {
      const parsed = parseSettingsText(draft.file.format, draft.rawText);
      if (!parsed.ok) continue;
      current = parsed.value;
    } else {
      current = draft.data;
    }

    const fileLabel = `${draft.file.label}（${draft.file.id}）`;
    for (const section of agent.sections) {
      walk(section.fields, [], fileLabel, current, draft.baseline);
    }
  }

  return { managedOnly: [...managedOnly], executable: [...executable] };
}

function withFile(report: SettingsReport, file: SettingsFileState): SettingsReport {
  return {
    ...report,
    agents: report.agents.map((agent) => ({
      ...agent,
      files: agent.files.map((entry) => (entry.id === file.id ? file : entry)),
    })),
  };
}

function removeJsonForPath(json: Record<string, JsonEntry>, fileId: string, path: string[]): void {
  const base = `:${fileId}:${pathLabel(path)}`;
  for (const key of Object.keys(json)) {
    const index = key.indexOf(base);
    if (index === -1) continue;
    const rest = key.slice(index + base.length);
    if (rest === '' || rest.startsWith(':') || rest.startsWith('.') || rest.startsWith('[')) {
      delete json[key];
    }
  }
}

export function SettingsView({
  version,
  onDirtyChange,
  onSaved,
  handleRef,
}: {
  version: number;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
  handleRef: { current: SettingsHandle | null };
}) {
  const [catalog, setCatalog] = useState<SettingsCatalog | null>(null);
  const [report, setReport] = useState<SettingsReport | null>(null);
  const [drafts, setDrafts] = useState<Record<string, FileDraft>>({});
  const [agentKey, setAgentKey] = useState('claude');
  const [nav, setNav] = useState<Nav>({ kind: 'common' });
  const [search, setSearch] = useState('');
  const [showUnset, setShowUnsetState] = useState(() => {
    try {
      return window.localStorage.getItem('agentmanager.showUnset') !== '0';
    } catch {
      return true;
    }
  });
  const setShowUnset = useCallback((next: boolean) => {
    setShowUnsetState(next);
    try {
      window.localStorage.setItem('agentmanager.showUnset', next ? '1' : '0');
    } catch {
      // Preference persistence is best effort.
    }
  }, []);
  const [busy, setBusy] = useState<'load' | 'save' | 'reload' | 'overwrite' | null>('load');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [navError, setNavError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [models, setModels] = useState<ModelsReport | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const seqRef = useRef(0);
  const dirtyRef = useRef(false);
  const toastTimer = useRef<number | undefined>(undefined);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const conflictRef = useRef<HTMLDivElement | null>(null);

  const showToast = useCallback((kind: 'success' | 'error', text: string) => {
    if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
    setToast({ kind, text });
    toastTimer.current = window.setTimeout(() => setToast(null), kind === 'error' ? 10_000 : 7_000);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const loadModels = useCallback(async (refresh = false) => {
    setModelsLoading(true);
    try {
      setModels(await api.models(refresh));
    } catch (reason) {
      setModels({
        source: '',
        fetchedAt: new Date().toISOString(),
        cached: false,
        error: errorMessage(reason),
        models: [],
      });
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadModels(false);
  }, [loadModels]);

  useEffect(() => {
    contentRef.current?.closest('.workspace')?.scrollTo({ top: 0 });
  }, [agentKey, nav.kind, nav.kind === 'section' ? nav.key : '']);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saveAll]);

  const load = useCallback(async (signal?: AbortSignal) => {
    const seq = ++seqRef.current;
    setBusy('load');
    try {
      const [nextCatalog, nextReport] = await Promise.all([
        api.settingsCatalog(signal),
        api.settings(signal),
      ]);
      if (seq !== seqRef.current || signal?.aborted) return;
      setCatalog(nextCatalog);
      setReport(nextReport);
      setDrafts((previous) => mergeDrafts(previous, nextReport));
      setLoadError(null);
      setBusy(null);
    } catch (reason) {
      if (seq !== seqRef.current || signal?.aborted || isAbortError(reason)) return;
      setLoadError(errorMessage(reason));
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, version]);

  useEffect(() => {
    if (catalog && !catalog.agents.some((agent) => agent.key === agentKey) && catalog.agents[0]) {
      setAgentKey(catalog.agents[0].key);
    }
  }, [catalog, agentKey]);

  const agent = catalog?.agents.find((entry) => entry.key === agentKey) ?? catalog?.agents[0];
  const agentFiles = agent ? filesOf(report, agent.key) : [];
  const primaryFile = agent ? pickPrimaryFile(agent, agentFiles) : undefined;
  const mcpFile = agent ? agentFiles.find((file) => file.id === agent.mcp.fileId) : undefined;
  const primaryDraft = primaryFile ? drafts[primaryFile.id] : undefined;
  const mcpDraft = mcpFile ? drafts[mcpFile.id] : undefined;

  const fieldIndex = useMemo(() => {
    const index = new Map<string, SettingsField>();
    for (const section of agent?.sections ?? []) {
      for (const field of section.fields) {
        if (!index.has(field.key)) index.set(field.key, field);
      }
    }
    return index;
  }, [agent]);

  const commonFields = useMemo(() => {
    if (!agent) return [];
    return agent.common
      .map((key) => fieldIndex.get(key))
      .filter((field): field is SettingsField => field !== undefined);
  }, [agent, fieldIndex]);

  const sensitivePathsByAgent = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const entry of catalog?.agents ?? []) {
      map.set(entry.key, collectSensitivePaths(entry.sections.flatMap((section) => section.fields)));
    }
    return map;
  }, [catalog]);

  const issuesByFile = useMemo(() => {
    const map = new Map<string, FileIssues>();
    for (const draft of Object.values(drafts)) {
      const agentCatalog = catalog?.agents.find((entry) => entry.key === draft.file.agent);
      if (!agentCatalog) continue;
      const primaryId = pickPrimaryFile(agentCatalog, filesOf(report, agentCatalog.key))?.id;
      const isPrimary = draft.file.id === primaryId;
      const isMcp = draft.file.id === agentCatalog.mcp.fileId;
      const fields = isPrimary
        ? collectFieldErrors(
            agentCatalog.sections.flatMap((section) => section.fields),
            draft.data,
          )
        : EMPTY_ERRORS;
      const mcp = isMcp ? validateMcpServers(mcpMapFor(draft, agentCatalog)) : EMPTY_ERRORS;
      const json = Object.entries(draft.json)
        .filter(([, entry]) => entry.error)
        .map(([label, entry]) => ({ label, error: entry.error as string }));
      let rawError: string | null = null;
      if (draft.mode === 'raw') {
        const parsed = parseSettingsText(draft.file.format, draft.rawText);
        if (!parsed.ok) rawError = parsed.error;
      }
      map.set(draft.file.id, {
        fields,
        mcp,
        json,
        rawError,
        count: fields.size + mcp.size + json.length + (rawError ? 1 : 0),
      });
    }
    return map;
  }, [drafts, catalog, report]);

  const changedDrafts = Object.values(drafts).filter(draftChanged);
  const dirtyCount = changedDrafts.length;
  const blockingCount = changedDrafts.reduce(
    (total, draft) => total + (issuesByFile.get(draft.file.id)?.count ?? 0),
    0,
  );
  const conflicts = Object.values(drafts).filter((draft) => draft.conflict !== null);

  useEffect(() => {
    if (conflicts.length > 0) {
      conflictRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [conflicts.length]);

  function scrollToFirstError() {
    const target = contentRef.current?.querySelector('[aria-invalid="true"], .field-error');
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  useEffect(() => {
    onDirtyChange(dirtyCount > 0);
    dirtyRef.current = dirtyCount > 0;
  }, [dirtyCount, onDirtyChange]);

  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const updateDraft = useCallback((fileId: string, update: (draft: FileDraft) => void) => {
    setDrafts((previous) => {
      const current = previous[fileId];
      if (!current) return previous;
      const next: FileDraft = {
        ...current,
        data: clone(current.data),
        json: { ...current.json },
      };
      update(next);
      return { ...previous, [fileId]: next };
    });
  }, []);

  const setValue = useCallback(
    (fileId: string, path: string[], value: unknown | undefined) => {
      updateDraft(fileId, (draft) => {
        if (value === undefined) deleteAt(draft.data, path);
        else setAt(draft.data, path, value);
        removeJsonForPath(draft.json, fileId, path);
        draft.error = null;
        draft.conflict = null;
      });
    },
    [updateDraft],
  );

  const clearValue = useCallback(
    (fileId: string, path: string[]) => {
      updateDraft(fileId, (draft) => {
        deleteAt(draft.data, path);
        removeJsonForPath(draft.json, fileId, path);
        draft.error = null;
      });
    },
    [updateDraft],
  );

  const setJsonText = useCallback(
    (
      fileId: string,
      label: string,
      text: string,
      apply: (data: JsonObject, value: unknown | undefined) => void,
    ) => {
      updateDraft(fileId, (draft) => {
        if (text.trim() === '') {
          draft.json[label] = { text };
          apply(draft.data, undefined);
          draft.error = null;
          return;
        }
        try {
          const value: unknown = JSON.parse(text);
          draft.json[label] = { text };
          apply(draft.data, value);
          draft.error = null;
        } catch (reason) {
          draft.json[label] = { text, error: errorText(reason) };
        }
      });
    },
    [updateDraft],
  );

  const resetAllDrafts = useCallback(() => {
    setDrafts((previous) => {
      const next: Record<string, FileDraft> = { ...previous };
      for (const [id, draft] of Object.entries(previous)) {
        if (!draftChanged(draft)) continue;
        next[id] = {
          ...draft,
          data: clone(draft.baseline),
          rawText: draft.baselineText,
          json: {},
          conflict: null,
          error: null,
          notice: null,
        };
      }
      return next;
    });
    setActionError(null);
    setNavError(null);
  }, []);

  useEffect(() => {
    handleRef.current = { discardAll: resetAllDrafts };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, resetAllDrafts]);

  function switchToForm(fileId: string): boolean {
    const draft = drafts[fileId];
    if (!draft || draft.mode === 'form') return true;
    const parsed = parseSettingsText(draft.file.format, draft.rawText);
    if (!parsed.ok) {
      setNavError(`「${draft.file.label}」的原文无法解析，未切换：${parsed.error}`);
      return false;
    }
    updateDraft(fileId, (entry) => {
      entry.data = parsed.value;
      entry.mode = 'form';
      entry.json = {};
      entry.conflict = null;
      entry.error = null;
    });
    setNavError(null);
    return true;
  }

  function chooseNav(next: Nav) {
    if (next.kind === 'models') {
      setNav(next);
      setNavError(null);
      setActionError(null);
      return;
    }
    if (next.kind === 'raw') {
      setNav(next);
      setNavError(null);
      return;
    }
    const targetId = next.kind === 'mcp' ? mcpFile?.id : primaryFile?.id;
    if (targetId && !switchToForm(targetId)) return;
    setNav(next);
    setNavError(null);
    setActionError(null);
  }

  function chooseAgent(key: string) {
    if (!agent || key === agent.key) return;
    if (
      dirtyCount > 0 &&
      !window.confirm(
        `还有 ${dirtyCount} 个文件未保存。切换 agent 会保留这些草稿，但当前表单会切走。继续吗？`,
      )
    ) {
      return;
    }
    setAgentKey(key);
    setNav({ kind: 'common' });
    setSearch('');
    setNavError(null);
    setActionError(null);
  }

  function updateMcpMap(fileId: string, map: JsonObject) {
    const draft = drafts[fileId];
    if (!draft) return;
    const agentCatalog = catalog?.agents.find((entry) => entry.key === draft.file.agent);
    if (!agentCatalog) return;
    updateDraft(fileId, (entry) => {
      if (entry.file.scope === 'mcp') {
        entry.data = clone(map);
      } else if (Object.keys(map).length === 0) {
        deleteAt(entry.data, [agentCatalog.mcp.key]);
      } else {
        setAt(entry.data, [agentCatalog.mcp.key], clone(map));
      }
      entry.error = null;
      entry.conflict = null;
    });
  }

  function resetDraftToBaseline(fileId: string) {
    updateDraft(fileId, (draft) => {
      draft.data = clone(draft.baseline);
      draft.rawText = draft.baselineText;
      draft.json = {};
      draft.conflict = null;
      draft.error = null;
      draft.notice = null;
    });
  }

  function replaceFile(file: SettingsFileState, mode: DraftMode) {
    const nextMode: DraftMode = file.parseError ? 'raw' : mode;
    setReport((previous) => (previous ? withFile(previous, file) : previous));
    setDrafts((previous) => ({ ...previous, [file.id]: toDraft(file, nextMode) }));
  }

  async function reloadFile(fileId: string) {
    if (busy) return;
    setBusy('reload');
    setActionError(null);
    try {
      const fresh = await api.settings();
      const file = fresh.agents.flatMap((agent) => agent.files).find((entry) => entry.id === fileId);
      if (!file) throw new Error(`服务器没有返回文件 ${fileId}`);
      setReport(fresh);
      setDrafts((previous) => {
        const merged = mergeDrafts(previous, fresh);
        merged[file.id] = toDraft(file);
        return merged;
      });
      setNotice(`已重新加载 ${file.label}。`);
    } catch (reason) {
      setActionError(`重新加载失败：${errorMessage(reason)}`);
    } finally {
      setBusy(null);
    }
  }

  async function overwriteFile(fileId: string) {
    const draft = drafts[fileId];
    if (!draft || busy) return;
    if (
      !window.confirm(
        `「${draft.file.label}」在磁盘上已被外部修改。用当前草稿覆盖会丢失外部的改动，继续吗？`,
      )
    ) {
      return;
    }
    if (!window.confirm('再次确认：覆盖后只能从快照还原，不会自动合并。确定覆盖？')) return;

    setBusy('overwrite');
    setActionError(null);
    try {
      const fresh = await api.settings();
      const file = fresh.agents.flatMap((agent) => agent.files).find((entry) => entry.id === fileId);
      if (!file) throw new Error(`服务器没有返回文件 ${fileId}`);
      const body =
        draft.mode === 'raw'
          ? { fileId, etag: file.etag, text: draft.rawText }
          : { fileId, etag: file.etag, data: draft.data };
      const result = await api.saveSettings(body);
      replaceFile(result.file, draft.mode);
      showToast('success', `已覆盖并保存 ${result.file.label} · 快照 ${result.snapshotId}`);
      onSaved();
    } catch (reason) {
      if (reason instanceof HttpError && reason.status === 409) {
        updateDraft(fileId, (entry) => {
          entry.conflict = reason.message;
        });
      }
      setActionError(`覆盖失败：${errorMessage(reason)}`);
      showToast('error', `覆盖失败：${errorMessage(reason)}`);
    } finally {
      setBusy(null);
    }
  }

  async function saveAll() {
    if (busy) return;
    if (!catalog || !report) return;
    const targets = Object.values(drafts).filter(draftChanged);
    if (targets.length === 0) return;
    if (blockingCount > 0) {
      showToast('error', `有 ${blockingCount} 处错误需要先修正，未执行保存。`);
      scrollToFirstError();
      return;
    }

    const flagChanges = collectFlagChanges(catalog, report, drafts);
    if (flagChanges.managedOnly.length > 0) {
      const proceed = window.confirm(
        `以下字段只在组织托管配置中生效，写入用户配置文件通常不会生效：\n\n` +
          `${flagChanges.managedOnly.join('\n')}\n\n仍要继续保存吗？`,
      );
      if (!proceed) return;
    }
    if (flagChanges.executable.length > 0) {
      const proceed = window.confirm(
        `以下字段会被 agent 当作命令执行（以当前用户身份）：\n\n` +
          `${flagChanges.executable.join('\n')}\n\n确认保存并允许执行吗？`,
      );
      if (!proceed) return;
    }

    setBusy('save');
    setActionError(null);
    setNotice(null);
    const snapshotIds: string[] = [];
    let saved = 0;
    try {
      for (const draft of targets) {
        const body =
          draft.mode === 'raw'
            ? { fileId: draft.file.id, etag: draft.file.etag, text: draft.rawText }
            : { fileId: draft.file.id, etag: draft.file.etag, data: draft.data };
        try {
          const result = await api.saveSettings(body);
          snapshotIds.push(result.snapshotId);
          saved += 1;
          replaceFile(result.file, draft.mode);
        } catch (reason) {
          if (reason instanceof HttpError && reason.status === 409) {
            updateDraft(draft.file.id, (entry) => {
              entry.conflict = reason.message;
            });
            setActionError(`「${draft.file.label}」已被外部修改，保存中止：${reason.message}`);
          } else {
            updateDraft(draft.file.id, (entry) => {
              entry.error = errorMessage(reason);
            });
            showToast('error', `保存「${draft.file.label}」失败：${errorMessage(reason)}`);
          }
          break;
        }
      }
      if (saved > 0) {
        const ids = [...new Set(snapshotIds)];
        showToast(
          'success',
          `已保存 ${saved} 个文件${ids.length > 0 ? ` · 快照 ${ids.join('、')}` : ''}`,
        );
        onSaved();
      }
    } finally {
      setBusy(null);
    }
  }

  function discardAll() {
    if (dirtyCount === 0) return;
    if (!window.confirm(`放弃 ${dirtyCount} 个文件的未保存修改？`)) return;
    resetAllDrafts();
    showToast('success', '已放弃未保存修改。');
  }

  function formatFile(fileId: string) {
    const draft = drafts[fileId];
    if (!draft) return;
    if (draft.mode === 'raw') {
      const parsed = parseSettingsText(draft.file.format, draft.rawText);
      if (!parsed.ok) {
        updateDraft(fileId, (entry) => {
          entry.error = `格式化失败：${parsed.error}`;
        });
        return;
      }
      try {
        const text = serializeSettingsText(draft.file.format, parsed.value);
        updateDraft(fileId, (entry) => {
          entry.rawText = text;
          entry.json = {};
          entry.error = null;
        });
      } catch (reason) {
        updateDraft(fileId, (entry) => {
          entry.error = `格式化失败：${errorText(reason)}`;
        });
      }
    } else {
      try {
        const text = deepEqual(draft.data, draft.baseline)
          ? draft.baselineText
          : serializeSettingsText(draft.file.format, draft.data);
        updateDraft(fileId, (entry) => {
          entry.mode = 'raw';
          entry.rawText = text;
          entry.json = {};
          entry.error = null;
        });
      } catch (reason) {
        updateDraft(fileId, (entry) => {
          entry.error = `无法序列化草稿：${errorText(reason)}`;
        });
      }
    }
  }

  function editRaw(fileId: string, text: string) {
    updateDraft(fileId, (draft) => {
      if (draft.mode !== 'raw') {
        draft.mode = 'raw';
        draft.json = {};
      }
      draft.rawText = text;
      draft.error = null;
      draft.conflict = null;
      draft.notice = null;
    });
  }

  function rawView(draft: FileDraft): { text: string; error: string | null } {
    if (draft.mode === 'raw') return { text: draft.rawText, error: null };
    if (deepEqual(draft.data, draft.baseline)) {
      return { text: draft.baselineText, error: null };
    }
    try {
      return { text: serializeSettingsText(draft.file.format, draft.data), error: null };
    } catch (reason) {
      return { text: draft.rawText, error: `无法序列化草稿：${errorText(reason)}` };
    }
  }

  function apiFor(draft: FileDraft, errors: Map<string, string>): FieldApi {
    const query = search.trim().toLowerCase();
    return {
      fileId: draft.file.id,
      data: draft.data,
      json: draft.json,
      errors,
      showUnset,
      query,
      expandAll: query !== '',
      disabled: busy !== null,
      setValue: (path, value) => setValue(draft.file.id, path, value),
      clearValue: (path) => clearValue(draft.file.id, path),
      setJsonText: (label, text, apply) =>
        setJsonText(draft.file.id, label, text, apply),
      jsonText: (label, value) =>
        draft.json[label]?.text ?? (value === undefined ? '' : JSON.stringify(value, null, 2)),
      modelOptions: models?.models ?? [],
      modelPaths: modelPathsFor(draft.file.agent),
    };
  }

  if (!catalog || !report) {
    if (loadError) {
      return (
        <section className="card empty-state">
          <p className="error">读取设置失败：{loadError}</p>
          <button type="button" className="primary" onClick={() => void load()}>
            重试
          </button>
        </section>
      );
    }
    return <section className="card empty-state muted">读取设置目录中…</section>;
  }

  if (!agent) {
    return <section className="card empty-state muted">设置目录里没有可用的 agent。</section>;
  }

  const query = search.trim().toLowerCase();
  const queryText = search.trim();
  const formDraft = primaryDraft;
  const issues = formDraft ? issuesByFile.get(formDraft.file.id) : undefined;
  const formApi = formDraft ? apiFor(formDraft, issues?.fields ?? EMPTY_ERRORS) : null;

  const sectionSetCount = (fields: SettingsField[]): number => {
    if (!formDraft) return 0;
    return uniqueFields(fields).filter((field) =>
      isSetValue(getAt(formDraft.data, [field.key])),
    ).length;
  };

  const commonTotal = commonFields.length;
  const commonSet = sectionSetCount(commonFields);
  const mcpCount = mcpDraft && agent
    ? Object.keys(mcpMapFor(mcpDraft, agent)).length
    : 0;

  const searchSections = query
    ? agent.sections
        .map((section) => ({
          section,
          fields: uniqueFields(section.fields).filter((field) =>
            fieldMatches(field, [], query),
          ),
        }))
        .filter((entry) => entry.fields.length > 0)
    : [];
  const searchCount = (() => {
    if (!query) return 0;
    const seen = new Set<string>();
    for (const entry of searchSections) {
      for (const field of entry.fields) seen.add(field.key);
    }
    return seen.size;
  })();

  const legacyClaudeMcp =
    agent.key === 'claude' &&
    primaryDraft !== undefined &&
    isSetValue(getAt(primaryDraft.data, ['mcpServers']));

  function renderPanel(
    title: string,
    fields: SettingsField[],
    setCount: number,
    total: number,
    extra?: ReactNode,
  ) {
    if (!formDraft || !formApi) return null;
    return (
      <section className="card settings-panel">
        <header className="panel-head">
          <div>
            <h2>{title}</h2>
            <p className="meta">
              {setCount}/{total} 已设置
              {formDraft.file.path ? ` · ${formDraft.file.path}` : ''}
            </p>
          </div>
          {formDraft.error && <span className="tag dirty">保存失败</span>}
        </header>
        {formDraft.error && <p className="error">{formDraft.error}</p>}
        {fields.length === 0 ? (
          <p className="muted">这个分组没有可显示的字段。</p>
        ) : (
          <>
            <FieldList fields={fields} basePath={[]} api={formApi} />
            {(!showUnset &&
              uniqueFields(fields).every(
                (field) => !isSetValue(getAt(formDraft.data, [field.key])),
              )) && <p className="muted">当前分组没有已设置的字段（关闭了「显示未设置项」）。</p>}
          </>
        )}
        {extra}
      </section>
    );
  }

  function renderFormExtras() {
    if (!formDraft || !formApi || query !== '') return null;
    const known = new Set<string>(fieldIndex.keys());
    known.add('$schema');
    if (primaryFile?.id === agent?.mcp.fileId && agent) known.add(agent.mcp.key);
    return (
      <>
        <UnknownKeysBlock api={formApi} path={[]} known={known} />
        <CustomKeyPanel api={formApi} />
      </>
    );
  }

  function modelTargetFor(agentKey: string): ModelTarget | null {
    const agentCatalog = catalog?.agents.find((entry) => entry.key === agentKey);
    if (!agentCatalog) return null;
    const file = pickPrimaryFile(agentCatalog, filesOf(report, agentKey));
    const draft = file ? drafts[file.id] : undefined;
    if (!file || !draft) return null;
    const text = (value: unknown) => (typeof value === 'string' ? value : '');

    if (agentKey === 'claude') {
      const env = isRecord(draft.data.env) ? draft.data.env : {};
      const envModel = text(env.ANTHROPIC_MODEL);
      const settingsModel = text(draft.data.model);
      const useEnv = envModel !== '';
      return {
        agentKey,
        agentLabel: agentCatalog.label,
        file,
        draft,
        path: useEnv ? ['env', 'ANTHROPIC_MODEL'] : ['model'],
        label: useEnv ? '生效模型 · env.ANTHROPIC_MODEL' : '设置模型 · settings.model',
        value: useEnv ? envModel : settingsModel,
        ...(useEnv && settingsModel ? { secondary: `settings.model = ${settingsModel}（被 env 覆盖）` } : {}),
        note: useEnv
          ? 'ANTHROPIC_MODEL 覆盖 settings.model；清空后将回落到 model。'
          : '未设置 env.ANTHROPIC_MODEL 时，由 settings.model 决定默认模型。',
      };
    }
    if (agentKey === 'codex') {
      const provider = text(draft.data.model_provider);
      return {
        agentKey,
        agentLabel: agentCatalog.label,
        file,
        draft,
        path: ['model'],
        label: '模型 · model',
        value: text(draft.data.model),
        ...(provider ? { secondary: `model_provider = ${provider}` } : {}),
        note: '写入 ~/.codex/config.toml 的 model。',
      };
    }
    if (agentKey === 'pi') {
      const provider = text(draft.data.defaultProvider);
      return {
        agentKey,
        agentLabel: agentCatalog.label,
        file,
        draft,
        path: ['defaultModel'],
        label: '默认模型 · defaultModel',
        value: text(draft.data.defaultModel),
        ...(provider ? { secondary: `defaultProvider = ${provider}` } : {}),
        note: '模型需存在于 pi 的 models.json；可用 pi 的同步脚本更新清单。',
      };
    }
    return null;
  }

  function applyModel(target: ModelTarget, value: string) {
    if (!switchToForm(target.file.id)) {
      showToast('error', '原始文件无法解析，未应用模型更改。');
      return;
    }
    setValue(target.file.id, target.path, value.trim() === '' ? undefined : value.trim());
  }

  function renderModelDatalist(agentKey: string) {
    const groups = new Map<string, ModelInfo[]>();
    for (const model of models?.models ?? []) {
      const list = groups.get(model.group) ?? [];
      list.push(model);
      groups.set(model.group, list);
    }
    return (
      <datalist id={`model-list-${agentKey}`}>
        {[...groups.entries()].map(([group, list]) => (
          <optgroup key={group} label={group === 'default' ? '默认' : group}>
            {list.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
                {model.contextWindow ? ` · ${formatTokens(model.contextWindow)}` : ''}
                {model.thinking ? ' · thinking' : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </datalist>
    );
  }

  function renderModelsContent() {
    const targets = ['claude', 'codex', 'pi']
      .map((key) => modelTargetFor(key))
      .filter((target): target is ModelTarget => target !== null);
    return (
      <div className="settings-panel models-panel">
        <header className="models-head">
          <div>
            <h2>模型</h2>
            <p className="meta">
              从本地 OpenAI 兼容端点读取模型列表，选择后写入各 agent 的配置文件；点底部「保存全部」生效。
            </p>
          </div>
          <button type="button" onClick={() => void loadModels(true)} disabled={modelsLoading}>
            {modelsLoading ? '刷新中…' : '刷新模型'}
          </button>
        </header>

        <p className="meta">
          来源 <code>{models?.source || '正在读取…'}</code>
          {models?.fetchedAt ? ` · 更新于 ${new Date(models.fetchedAt).toLocaleTimeString()}` : ''}
          {models?.cached ? ' · 缓存' : ''}
          {models?.stale ? ' · 端点不可用，显示上次结果' : ''}
        </p>
        {models?.error && (
          <p className="error">模型列表读取失败：{models.error}；仍可手动输入模型 ID。</p>
        )}
        {modelsLoading && !models && <p className="muted">读取模型列表…</p>}

        <div className="table-wrap model-table-wrap">
          <table className="model-table">
            <thead>
              <tr>
                <th scope="col">agent</th>
                <th scope="col">模型</th>
                <th scope="col">写入位置</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((target) => {
                const selected = models?.models.find((model) => model.id === target.value);
                const custom =
                  target.value !== '' && !selected && (models?.models.length ?? 0) > 0;
                return (
                  <tr key={target.agentKey}>
                    <th scope="row">
                      <span className="model-agent">{target.agentLabel}</span>
                      <span className="meta">{target.file.format.toUpperCase()}</span>
                    </th>
                    <td>
                      <input
                        className="control"
                        list={`model-list-${target.agentKey}`}
                        value={target.value}
                        placeholder="选择或输入模型 ID"
                        spellCheck={false}
                        autoComplete="off"
                        aria-label={`${target.agentLabel} 模型`}
                        onChange={(event) => applyModel(target, event.target.value)}
                      />
                      {renderModelDatalist(target.agentKey)}
                      <div className="model-notes">
                        {selected && <span className="model-meta">{modelMeta(selected)}</span>}
                        {custom && <span className="hint">当前值不在模型列表中，仍会按原样保存。</span>}
                        {target.secondary && <span className="hint">{target.secondary}</span>}
                      </div>
                    </td>
                    <td className="model-source">
                      <code title={target.file.path}>{compactPath(target.file.path)}</code>
                      <span className="meta">{target.label}</span>
                      {target.note && <span className="hint">{target.note}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="hint">
          模型源可用环境变量 <code>AGENT_MANAGER_MODELS_URL</code> 覆盖，默认
          <code>http://127.0.0.1:15721/v1</code>。
        </p>
      </div>
    );
  }

  function renderFormContent() {
    if (!formDraft || !formApi) {
      return <p className="muted">没有找到该 agent 的设置文件。</p>;
    }
    if (formDraft.mode !== 'form') {
      return (
        <section className="card settings-panel">
          <p className="warning">
            「{formDraft.file.label}」当前处于原始文本模式，无法按 schema 渲染表单。
          </p>
          {issues?.rawError && <p className="field-error">原文解析失败：{issues.rawError}</p>}
          <button type="button" onClick={() => setNav({ kind: 'raw' })}>
            前往原始文件编辑器
          </button>
        </section>
      );
    }

    if (query !== '') {
      return (
        <>
          <p className="search-summary">
            在全部字段中搜索「{queryText}」，共 {searchCount} 项匹配。
          </p>
          {searchSections.length === 0 ? (
            <section className="card empty-state">
              <p className="muted">没有匹配的字段。</p>
              <button type="button" onClick={() => setSearch('')}>
                清除搜索
              </button>
            </section>
          ) : (
            searchSections.map(({ section, fields }) =>
              renderPanel(section.label, fields, sectionSetCount(fields), fields.length),
            )
          )}
        </>
      );
    }

    if (nav.kind === 'common') {
      return (
        <>
          {renderPanel('常用设置', commonFields, commonSet, commonTotal)}
          {renderFormExtras()}
        </>
      );
    }

    if (nav.kind !== 'section') {
      return <p className="muted">该分组不存在。</p>;
    }

    const section = agent?.sections.find((entry) => entry.key === nav.key);
    if (!section) {
      return <p className="muted">该分组不存在。</p>;
    }
    const fields = uniqueFields(section.fields);
    return (
      <>
        {renderPanel(section.label, fields, sectionSetCount(fields), fields.length)}
        {renderFormExtras()}
      </>
    );
  }

  function renderMcpContent() {
    if (!mcpFile || !mcpDraft || !agent) {
      return <p className="muted">该 agent 没有注册 MCP 配置文件。</p>;
    }
    if (mcpDraft.mode !== 'form') {
      return (
        <section className="card settings-panel">
          <p className="warning">MCP 文件当前处于原始文本模式。</p>
          {issuesByFile.get(mcpDraft.file.id)?.rawError && (
            <p className="field-error">
              原文解析失败：{issuesByFile.get(mcpDraft.file.id)?.rawError}
            </p>
          )}
          <button type="button" onClick={() => setNav({ kind: 'raw' })}>
            前往原始文件编辑器
          </button>
        </section>
      );
    }
    if (mcpDraft.file.parseError) {
      return (
        <section className="card settings-panel">
          <p className="warning">MCP 文件读取时解析失败：{mcpDraft.file.parseError}</p>
          <button type="button" onClick={() => setNav({ kind: 'raw' })}>
            前往原始文件编辑器
          </button>
        </section>
      );
    }
    const map = mcpMapFor(mcpDraft, agent);
    const errors = issuesByFile.get(mcpDraft.file.id)?.mcp ?? EMPTY_ERRORS;
    return (
      <section className="card settings-panel">
        <header className="panel-head">
          <div>
            <h2>MCP servers</h2>
            <p className="meta">
              <code>{mcpFile.id}</code> · {mcpFile.path} · {Object.keys(map).length} 个 server
            </p>
          </div>
          <span className="tag">{mcpFile.scope === 'mcp' ? '只读写服务器映射' : '写入完整文件'}</span>
        </header>
        {agent.key === 'claude' && (
          <p className="hint">
            用户级 MCP 的官方位置是 <code>~/.claude.json</code>；本页写入{' '}
            <code>{mcpFile.path}</code>，其它键会原样保留。
          </p>
        )}
        {legacyClaudeMcp && (
          <p className="warning">
            检测到 <code>~/.claude/settings.json</code> 里还有旧版 <code>mcpServers</code>。
            本页写入的是 <code>~/.claude.json</code>，旧键不会自动迁移，可在「原始文件」里手动清理。
          </p>
        )}
        {mcpDraft.error && <p className="error">{mcpDraft.error}</p>}
        <McpEditor
          agentKey={agent.key}
          map={map}
          errors={errors}
          disabled={busy !== null}
          query={query}
          onChange={(next) => updateMcpMap(mcpDraft.file.id, next)}
        />
      </section>
    );
  }

  function renderRawContent() {
    const files = agentFiles.filter((file) => {
      if (query === '') return true;
      return `${file.label} ${file.id} ${file.path} ${file.role}`.toLowerCase().includes(query);
    });
    if (files.length === 0) {
      return (
        <section className="card empty-state">
          <p className="muted">
            {query === '' ? '该 agent 没有配置文件。' : '没有匹配的文件。'}
          </p>
        </section>
      );
    }
    return (
      <>
        {files.map((file) => {
          const draft = drafts[file.id];
          if (!draft) return null;
          const view = rawView(draft);
          const sensitivePaths =
            file.id === primaryFile?.id
              ? (sensitivePathsByAgent.get(file.agent) ?? new Set<string>())
              : new Set<string>();
          const isPrimary = file.id === primaryFile?.id;
          const isMcp = file.id === agent?.mcp.fileId;
          const formLabel = isPrimary ? '表单' : isMcp ? ' MCP 编辑器' : null;
          return (
            <RawEditor
              key={file.id}
              file={file}
              text={view.text}
              sensitivePaths={sensitivePaths}
              dirty={draftDirty(draft)}
              busy={busy !== null}
              error={view.error ?? draft.error}
              notice={draft.notice}
              formLabel={formLabel}
              onUseForm={
                formLabel
                  ? () => {
                      if (!switchToForm(file.id)) return;
                      if (isMcp && !isPrimary) setNav({ kind: 'mcp' });
                      else setNav({ kind: 'common' });
                    }
                  : undefined
              }
              onChangeText={(text) => editRaw(file.id, text)}
              onFormat={() => formatFile(file.id)}
              onReload={() => void reloadFile(file.id)}
            />
          );
        })}
        <p className="hint">
          原始编辑器与表单共用同一份草稿；保存时会逐个文件写入并自动创建快照。
        </p>
      </>
    );
  }

  let content: ReactNode;
  if (nav.kind === 'models') {
    content = renderModelsContent();
  } else if (agentFiles.length === 0) {
    content = (
      <section className="card empty-state">
        <p className="muted">没有找到 {agent.label} 的配置文件，可能尚未安装或路径不存在。</p>
        <p className="hint">全局「重新扫描」会重新读取配置文件列表。</p>
      </section>
    );
  } else if (nav.kind === 'mcp') {
    content = renderMcpContent();
  } else if (nav.kind === 'raw') {
    content = renderRawContent();
  } else {
    content = renderFormContent();
  }

  const navSections: SettingsSection[] = agent.sections;

  return (
    <section className="settings-page">
      <div className="agent-switch" role="tablist" aria-label="选择 agent">
        {catalog.agents.map((entry) => {
          const files = filesOf(report, entry.key);
          const detected = files.some((file) => file.exists);
          const selected = entry.key === agent.key;
          return (
            <button
              key={entry.key}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="settings-panel-body"
              className={selected ? 'agent-tab is-active' : 'agent-tab'}
              onClick={() => chooseAgent(entry.key)}
            >
              <span className="agent-name">{entry.label}</span>
              <span className="agent-meta">
                {detected ? '已检测' : '未检测'} · {files.length} 个文件
              </span>
            </button>
          );
        })}
      </div>

      <div className="settings-body" id="settings-panel-body" role="tabpanel" aria-label={`${agent.label} 设置`}>
        <aside className="settings-nav">
          <nav aria-label="设置分类">
            <ul>
              <li>
                <button
                  type="button"
                  className={nav.kind === 'models' ? 'nav-item is-active' : 'nav-item'}
                  aria-current={nav.kind === 'models' ? 'page' : undefined}
                  onClick={() => chooseNav({ kind: 'models' })}
                >
                  模型
                  <span className="nav-count">{models ? models.models.length : '—'}</span>
                </button>
              </li>
              <li>
                <button
                  type="button"
                  className={nav.kind === 'common' ? 'nav-item is-active' : 'nav-item'}
                  aria-current={nav.kind === 'common' ? 'page' : undefined}
                  onClick={() => chooseNav({ kind: 'common' })}
                >
                  常用
                  <span className="nav-count">
                    {commonSet}/{commonTotal}
                  </span>
                </button>
              </li>
              {navSections.map((section) => {
                const count = sectionSetCount(section.fields);
                return (
                  <li key={section.key}>
                    <button
                      type="button"
                      className={
                        nav.kind === 'section' && nav.key === section.key
                          ? 'nav-item is-active'
                          : 'nav-item'
                      }
                      aria-current={
                        nav.kind === 'section' && nav.key === section.key ? 'page' : undefined
                      }
                      onClick={() => chooseNav({ kind: 'section', key: section.key })}
                    >
                      {section.label}
                      <span className="nav-count">
                        {count}/{uniqueFields(section.fields).length}
                      </span>
                    </button>
                  </li>
                );
              })}
              <li>
                <button
                  type="button"
                  className={nav.kind === 'mcp' ? 'nav-item is-active' : 'nav-item'}
                  aria-current={nav.kind === 'mcp' ? 'page' : undefined}
                  onClick={() => chooseNav({ kind: 'mcp' })}
                >
                  MCP servers
                  <span className="nav-count">{mcpCount}</span>
                </button>
              </li>
              <li>
                <button
                  type="button"
                  className={nav.kind === 'raw' ? 'nav-item is-active' : 'nav-item'}
                  aria-current={nav.kind === 'raw' ? 'page' : undefined}
                  onClick={() => chooseNav({ kind: 'raw' })}
                >
                  原始文件
                  <span className="nav-count">{agentFiles.length}</span>
                </button>
              </li>
            </ul>
          </nav>
        </aside>

        <div className="settings-content" ref={contentRef}>
          <div className="settings-tools">
            <label className="search-field">
              <span className="sr-only">搜索字段、说明或路径</span>
              <input
                type="search"
                value={search}
                placeholder="搜索字段、说明或路径…"
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setSearch('');
                    event.currentTarget.blur();
                  }
                }}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={showUnset}
                onChange={(event) => setShowUnset(event.target.checked)}
              />
              <span>显示未设置项</span>
            </label>
            {query !== '' && (
              <button type="button" className="link-button" onClick={() => setSearch('')}>
                清除搜索
              </button>
            )}
          </div>

          <div aria-live="polite" className="settings-messages">
            {loadError && (
              <p className="error">
                刷新失败：{loadError}（下方是上次读取的数据）
                <button type="button" onClick={() => void load()}>
                  重试
                </button>
              </p>
            )}
            {navError && <p className="error">{navError}</p>}
            {actionError && <p className="error">{actionError}</p>}
            {notice && <p className="notice">{notice}</p>}
            {conflicts.map((draft, index) => (
              <div
                className="conflict"
                role="alert"
                key={draft.file.id}
                ref={index === 0 ? conflictRef : undefined}
              >
                <div>
                  <strong>{draft.file.label}</strong>（<code>{draft.file.id}</code>）已被外部修改。
                  <span className="meta"> {draft.conflict}</span>
                </div>
                <div className="confirm-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy !== null}
                    onClick={() => void reloadFile(draft.file.id)}
                  >
                    重新加载
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy !== null}
                    onClick={() => void overwriteFile(draft.file.id)}
                  >
                    仍然覆盖
                  </button>
                </div>
              </div>
            ))}
          </div>

          {content}
        </div>
      </div>

      {dirtyCount > 0 && (
        <div className="save-bar" role="status">
          <div className="save-copy">
            <strong>{dirtyCount} 个文件有未保存修改</strong>
            <span className="meta">
              {blockingCount > 0
                ? `${blockingCount} 处错误需要修正后才能保存`
                : '保存前自动快照 · Ctrl+S 保存'}
            </span>
          </div>
          <div className="confirm-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy !== null}
              onClick={discardAll}
            >
              放弃
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy !== null || blockingCount > 0}
              onClick={() => void saveAll()}
            >
              {busy === 'save' ? '保存中…' : '保存全部'}
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div className={`toast toast-${toast.kind}`} role="status" aria-live="polite">
          <span>{toast.text}</span>
          <button
            type="button"
            className="icon-button"
            onClick={() => setToast(null)}
            aria-label="关闭提示"
          >
            ×
          </button>
        </div>
      )}
    </section>
  );
}
