import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { api, errorMessage, isAbortError } from './api.ts';
import type {
  ConfigReport,
  HealthResponse,
  HookMatrixReport,
  MatrixResponse,
  McpMatrixReport,
  PromptsReport,
  PromptState,
  SettingsReport,
} from '../../shared/types.ts';
import { countHookRows, countMcpRows, countSkillRows } from './lib/attention.ts';
import { McpView } from './views/McpView.tsx';
import { CacheView } from './views/CacheView.tsx';
import { HooksView } from './views/HooksView.tsx';
import { PromptsView } from './views/PromptsView.tsx';
import { ProviderView } from './views/ProviderView.tsx';
import type { PromptsHandle } from './views/PromptsView.tsx';
import { SettingsView } from './views/SettingsView.tsx';
import type { SettingsHandle } from './views/SettingsView.tsx';
import { SkillsView } from './views/SkillsView.tsx';
import { StoreView } from './views/StoreView.tsx';
import { SnapshotsPanel } from './views/SnapshotsPanel.tsx';
import { useConfirmDialog } from './lib/confirm.tsx';
import { THEME_OPTIONS, applyTheme, loadTheme, rememberTheme } from './lib/theme.ts';
import type { ThemeMode } from './lib/theme.ts';

/** The index numbers are the sidebar's address for each page; keep them stable. */
const TABS = [
  {
    key: 'skills',
    label: 'Skills',
    title: 'Skills',
    group: '管理资产',
    lede: '查看每个 skill 在三个 agent 中的链接状态。',
  },
  {
    key: 'store',
    label: '商店',
    title: '商店',
    group: '管理资产',
    lede: '搜索并安装 skill 与 MCP server，再链接或同步到三个 agent。',
  },
  {
    key: 'provider',
    label: 'Provider',
    title: 'Provider',
    group: '单一源',
    lede: '选择模型来源，读取可用模型。',
  },
  {
    key: 'prompts',
    label: '提示词',
    title: '提示词',
    group: '单一源',
    lede: '维护所有 agent 共用的全局提示词。',
  },
  {
    key: 'mcp',
    label: 'MCP',
    title: 'MCP',
    group: '单一源',
    lede: '维护一份 MCP 定义，同步到三个 agent。',
  },
  {
    key: 'hooks',
    label: 'Hooks',
    title: 'Hooks',
    group: '单一源',
    lede: '维护一份 hooks 事件源，同步到 Claude Code 与 Codex。',
  },
  {
    key: 'cache',
    label: '缓存',
    title: '缓存',
    group: '本机维护',
    lede: '查看缓存占用；清理先进回收站，可恢复。',
  },
  {
    key: 'settings',
    label: '设置',
    title: '设置',
    group: '本机维护',
    lede: '编辑每个 agent 的用户级配置。',
  },
] as const;

/** Sidebar groups, in reading order. Every tab belongs to exactly one. */
const NAV_GROUPS = [
  { label: '管理资产', keys: ['skills', 'store'] },
  { label: '单一源', keys: ['provider', 'prompts', 'mcp', 'hooks'] },
  { label: '本机维护', keys: ['cache', 'settings'] },
] as const;

type TabKey = (typeof TABS)[number]['key'];

const PROMPT_STATE_SHORT: Record<PromptState, string> = {
  'no-source': '提示词源未建立',
  missing: '提示词缺失',
  synced: '提示词已同步',
  drift: '提示词待对齐',
  broken: '提示词链接失效',
  'external-link': '提示词指向别处',
};

interface AgentStatus {
  key: string;
  label: string;
  detected: boolean;
  fileCount: number | null;
  existsCount: number;
  promptState: PromptState | null;
}

function agentTitle(agent: AgentStatus): string {
  const files =
    agent.fileCount === null ? '配置文件未知' : `${agent.existsCount}/${agent.fileCount} 个文件`;
  const prompt = agent.promptState ? ` · ${PROMPT_STATE_SHORT[agent.promptState]}` : '';
  return `${agent.label}：${agent.detected ? '已检测' : '未检测'} · ${files}${prompt}`;
}

function tabFromHash(): TabKey {
  const hash = window.location.hash.replace('#', '');
  const match = TABS.find((entry) => entry.key === hash);
  return match ? match.key : 'skills';
}

export default function App() {
  const [tab, setTab] = useState<TabKey>(tabFromHash);
  const [dataVersion, setDataVersion] = useState(0);
  const [snapshotVersion, setSnapshotVersion] = useState(0);
  const [theme, setTheme] = useState<ThemeMode>(() => loadTheme());
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [promptsReport, setPromptsReport] = useState<PromptsReport | null>(null);
  const [matrixReport, setMatrixReport] = useState<MatrixResponse | null>(null);
  const [settingsReport, setSettingsReport] = useState<SettingsReport | null>(null);
  const [configReport, setConfigReport] = useState<ConfigReport | null>(null);
  const [hooksReport, setHooksReport] = useState<HookMatrixReport | null>(null);
  const [mcpReport, setMcpReport] = useState<McpMatrixReport | null>(null);
  const [metaErrors, setMetaErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [quitting, setQuitting] = useState(false);
  // Mirrors the dirty refs for rendering: a draft on screen makes "重新扫描" secondary.
  const [draftDirty, setDraftDirty] = useState(false);

  const promptsDirty = useRef(false);
  const settingsDirty = useRef(false);
  const providerDirty = useRef(false);
  const promptsHandle = useRef<PromptsHandle | null>(null);
  const settingsHandle = useRef<SettingsHandle | null>(null);
  const metaSeq = useRef(0);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const navRef = useRef<HTMLDivElement | null>(null);
  const [ask, confirmNode] = useConfirmDialog();

  useEffect(() => {
    workspaceRef.current?.scrollTo({ top: 0 });
  }, [tab]);

  // On phones the nav scrolls sideways; keep the active tab in view instead of off-screen.
  useEffect(() => {
    navRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tab]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const entry = TABS.find((candidate) => candidate.key === tab) ?? TABS[0];
    document.title = `${entry.title} · AgentManager`;
  }, [tab]);

  const loadMeta = useCallback(async (signal?: AbortSignal) => {
    const seq = ++metaSeq.current;
    const results = await Promise.allSettled([
      api.health(signal),
      api.prompts(signal),
      api.matrix(signal),
      api.settings(signal),
      api.config(signal),
      api.hooks(signal),
      api.mcp(signal),
    ]);
    if (seq !== metaSeq.current || signal?.aborted) return;

    const errors: string[] = [];
    const [healthResult, promptsResult, matrixResult, settingsResult, configResult, hooksResult, mcpResult] = results;
    if (healthResult.status === 'fulfilled') setHealth(healthResult.value);
    else if (!isAbortError(healthResult.reason)) errors.push(`版本信息：${errorMessage(healthResult.reason)}`);

    if (promptsResult.status === 'fulfilled') setPromptsReport(promptsResult.value);
    else if (!isAbortError(promptsResult.reason)) errors.push(`提示词摘要：${errorMessage(promptsResult.reason)}`);

    if (matrixResult.status === 'fulfilled') setMatrixReport(matrixResult.value);
    else if (!isAbortError(matrixResult.reason)) errors.push(`Skills 摘要：${errorMessage(matrixResult.reason)}`);

    if (settingsResult.status === 'fulfilled') setSettingsReport(settingsResult.value);
    else if (!isAbortError(settingsResult.reason)) errors.push(`设置摘要：${errorMessage(settingsResult.reason)}`);

    if (configResult.status === 'fulfilled') setConfigReport(configResult.value);
    else if (!isAbortError(configResult.reason)) errors.push(`MCP 摘要：${errorMessage(configResult.reason)}`);

    if (hooksResult.status === 'fulfilled') setHooksReport(hooksResult.value);
    else if (!isAbortError(hooksResult.reason)) errors.push(`Hooks 摘要：${errorMessage(hooksResult.reason)}`);

    if (mcpResult.status === 'fulfilled') setMcpReport(mcpResult.value);
    else if (!isAbortError(mcpResult.reason)) errors.push(`MCP 矩阵：${errorMessage(mcpResult.reason)}`);

    setMetaErrors(errors);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadMeta(controller.signal);
    return () => controller.abort();
  }, [dataVersion, loadMeta]);

  useEffect(() => {
    const onHashChange = () => {
      const next = tabFromHash();
      if (next === tab) return;
      const dirty: string[] = [];
      if (tab === 'prompts' && promptsDirty.current) dirty.push('提示词');
      if (tab === 'settings' && settingsDirty.current) dirty.push('设置');
      if (tab === 'provider' && providerDirty.current) dirty.push('Provider');
      if (dirty.length > 0) {
        const description = `${dirty.join('、')}有未保存的修改，切换页面会放弃这些修改。`;
        void ask({
          title: '切换页面',
          message: description,
          confirmLabel: '放弃并切换',
          danger: true,
        }).then((discard) => {
          if (discard) setTab(next);
          else window.location.hash = tab;
        });
        return;
      }
      setTab(next);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [ask, tab]);

  const agents = useMemo<AgentStatus[]>(() => {
    const keys = new Set(['claude', 'codex', 'pi']);
    for (const agent of settingsReport?.agents ?? []) keys.add(agent.key);
    for (const agent of matrixReport?.agents ?? []) keys.add(agent.key);
    for (const target of promptsReport?.targets ?? []) keys.add(target.key);

    const labels = new Map<string, string>();
    for (const agent of settingsReport?.agents ?? []) labels.set(agent.key, agent.label);
    for (const agent of matrixReport?.agents ?? []) labels.set(agent.key, agent.label);
    for (const target of promptsReport?.targets ?? []) labels.set(target.key, target.label);

    const detected = new Map(
      (matrixReport?.agents ?? []).map((agent) => [agent.key, agent.detected]),
    );
    const settingsFiles = new Map(
      (settingsReport?.agents ?? []).map((agent) => [agent.key, agent.files]),
    );

    return [...keys].map((key) => {
      const files = settingsFiles.get(key);
      const prompt = promptsReport?.targets.find((target) => target.key === key) ?? null;
      return {
        key,
        label: labels.get(key) ?? key,
        detected: detected.get(key) ?? (files?.some((file) => file.exists) ?? false),
        fileCount: files === undefined ? null : files.length,
        existsCount: files?.filter((file) => file.exists).length ?? 0,
        promptState: prompt?.state ?? null,
      };
    });
  }, [settingsReport, matrixReport, promptsReport]);

  const promptSummary = promptsReport
    ? promptsReport.source.exists
      ? `${promptsReport.targets.filter((target) => target.state === 'synced').length}/${promptsReport.targets.length} 同步`
      : '源未建立'
    : '读取中…';

  const mcpSummary = configReport ? `${configReport.servers.length} 个 server` : '读取中…';

  // Drift is the thing that should never go unnoticed: one row count per binding page, each
  // acting as a shortcut to that page.
  const attention = useMemo(
    () => [
      { key: 'skills' as const, label: 'Skills', count: countSkillRows(matrixReport?.rows) },
      { key: 'mcp' as const, label: 'MCP', count: countMcpRows(mcpReport?.rows) },
      { key: 'hooks' as const, label: 'Hooks', count: countHookRows(hooksReport) },
    ],
    [matrixReport, mcpReport, hooksReport],
  );
  const attentionTotal = attention.reduce((sum, entry) => sum + entry.count, 0);

  function anyDirty(): boolean {
    return promptsDirty.current || settingsDirty.current || providerDirty.current;
  }

  function select(key: TabKey) {
    if (key === tab) return;
    window.location.hash = key;
  }

  /** Arrow keys walk the tabs and activate them, matching the tablist contract. */
  function onNavKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = Math.max(0, TABS.findIndex((entry) => entry.key === tab));
    let next = index;
    if (event.key === 'ArrowDown') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else next = TABS.length - 1;
    const entry = TABS[next] ?? TABS[0];
    navRef.current?.querySelector<HTMLButtonElement>(`#nav-${entry.key}`)?.focus();
    select(entry.key);
  }

  async function rescan() {
    if (anyDirty()) {
      const discard = await ask({
        title: '重新扫描',
        message: '当前页面有未保存的修改，重新扫描会放弃这些修改并重新读取磁盘。',
        confirmLabel: '放弃并重新扫描',
        danger: true,
      });
      if (!discard) return;
      promptsHandle.current?.discardAndReload();
      settingsHandle.current?.discardAll();
    }
    setNotice(null);
    setDataVersion((current) => current + 1);
    setSnapshotVersion((current) => current + 1);
  }

  const changed = useCallback(() => {
    setDataVersion((current) => current + 1);
    setSnapshotVersion((current) => current + 1);
  }, []);

  const restored = useCallback(() => {
    setDataVersion((current) => current + 1);
    setSnapshotVersion((current) => current + 1);
  }, []);

  const snapshotsChanged = useCallback(() => {
    setSnapshotVersion((current) => current + 1);
  }, []);

  const settingsSaved = useCallback(() => {
    setSnapshotVersion((current) => current + 1);
    void loadMeta();
  }, [loadMeta]);

  const markPromptsDirty = useCallback((dirty: boolean) => {
    promptsDirty.current = dirty;
    setDraftDirty(promptsDirty.current || settingsDirty.current || providerDirty.current);
  }, []);

  const markSettingsDirty = useCallback((dirty: boolean) => {
    settingsDirty.current = dirty;
    setDraftDirty(promptsDirty.current || settingsDirty.current || providerDirty.current);
  }, []);

  const markProviderDirty = useCallback((dirty: boolean) => {
    providerDirty.current = dirty;
    setDraftDirty(promptsDirty.current || settingsDirty.current || providerDirty.current);
  }, []);

  function chooseTheme(mode: ThemeMode) {
    setTheme(mode);
    rememberTheme(mode);
  }

  async function quit() {
    const dirty = anyDirty();
    const proceed = await ask({
      title: '退出 AgentManager',
      message: dirty
        ? '后台服务会一并停止，当前页面未保存的修改会丢失。'
        : '后台服务会一并停止，之后可以再次双击 AgentManager.exe 启动。',
      confirmLabel: '退出',
      danger: true,
    });
    if (!proceed) return;
    setQuitting(true);
    setNotice(null);
    try {
      await api.quit();
      setNotice('AgentManager 已停止，可以关闭这个窗口了。');
    } catch (reason) {
      setNotice(`停止失败：${errorMessage(reason)}`);
    } finally {
      setQuitting(false);
    }
  }

  const activeTab = TABS.find((entry) => entry.key === tab) ?? TABS[0];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-seal" aria-hidden="true">
            AM
          </span>
          <span className="brand-copy">
            <strong>AgentManager</strong>
            <span>本地 agent 配置索引</span>
          </span>
        </div>

        <nav className="side-nav" aria-label="主导航">
          <div
            className="nav-list"
            role="tablist"
            aria-orientation="vertical"
            ref={navRef}
            onKeyDown={onNavKeyDown}
          >
            {NAV_GROUPS.map((group) => (
              <div key={group.label} className="nav-group" role="presentation">
                <h2 className="nav-group-label">{group.label}</h2>
                {group.keys.map((key) => {
                  const entry = TABS.find((candidate) => candidate.key === key);
                  if (!entry) return null;
                  const count = attention.find((item) => item.key === key)?.count ?? 0;
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      role="tab"
                      id={`nav-${entry.key}`}
                      title={count > 0 ? `${entry.title} · ${count} 项需处理` : `${entry.group} · ${entry.title}`}
                      aria-selected={entry.key === tab}
                      aria-controls="workspace-panel"
                      className={entry.key === tab ? 'side-link is-active' : 'side-link'}
                      onClick={() => select(entry.key)}
                    >
                      <span className="side-link-label">{entry.label}</span>
                      {count > 0 && <span className="nav-badge">{count}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </nav>

        <section
          className={attentionTotal > 0 ? 'side-attention is-active' : 'side-attention'}
          role="status"
          aria-live="polite"
          aria-label="需处理"
        >
          <span className="side-attention-label">需处理</span>
          {metaErrors.length > 0 && !matrixReport && !configReport && !hooksReport ? (
            <span className="side-attention-empty">读取中…</span>
          ) : attentionTotal === 0 ? (
            <span className="side-attention-empty">没有待处理的差异</span>
          ) : (
            <div className="side-attention-list">
              {attention
                .filter((entry) => entry.count > 0)
                .map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    className="link-button"
                    title={`跳到${entry.label}页查看差异`}
                    aria-label={`${entry.label}：${entry.count} 项需处理`}
                    onClick={() => select(entry.key)}
                  >
                    <span>{entry.label} </span>
                    <span>{entry.count}</span>
                  </button>
                ))}
            </div>
          )}
          {metaErrors.length > 0 && (
            <p className="side-error" title={metaErrors.join('；')}>
              部分状态读取失败{' '}
              <button type="button" className="link-button" onClick={() => void loadMeta()}>
                重试
              </button>
            </p>
          )}
        </section>
      </aside>

      <div className="app-main">
        <header className="page-head">
          <div className="page-title">
            <h1>{activeTab.title}</h1>
            <p className="lede">{activeTab.lede}</p>
          </div>
          <div className="head-tools">
            <button
              type="button"
              className={draftDirty ? 'secondary rescan is-dirty' : 'secondary rescan'}
              onClick={() => void rescan()}
            >
              重新扫描
            </button>
          </div>
        </header>

        <main
          className="workspace"
          id="workspace-panel"
          role="tabpanel"
          aria-labelledby={`nav-${activeTab.key}`}
          ref={workspaceRef}
        >
          {notice && <p className="notice">{notice}</p>}

          {tab === 'skills' && <SkillsView version={dataVersion} onChanged={changed} />}
          {tab === 'store' && (
            <StoreView
              version={dataVersion}
              agents={agents}
              onChanged={changed}
              onOpenSkills={() => select('skills')}
            />
          )}
          {tab === 'mcp' && <McpView version={dataVersion} onChanged={changed} />}
          {tab === 'hooks' && <HooksView version={dataVersion} onChanged={changed} />}
          {tab === 'provider' && (
            <ProviderView
              version={dataVersion}
              onDirtyChange={markProviderDirty}
              onSnapshotsChanged={snapshotsChanged}
            />
          )}
          {tab === 'prompts' && (
            <PromptsView
              version={dataVersion}
              onChanged={changed}
              onDirtyChange={markPromptsDirty}
              handleRef={promptsHandle}
            />
          )}
          {tab === 'settings' && (
            <SettingsView
              version={dataVersion}
              onDirtyChange={markSettingsDirty}
              onSaved={settingsSaved}
              handleRef={settingsHandle}
            />
          )}
          {tab === 'cache' && <CacheView version={dataVersion} />}

          <SnapshotsPanel version={snapshotVersion} onRestored={restored} />
        </main>
      </div>

      <footer className="status-bar" aria-label="运行状态">
        <div className="status-agents">
          {agents.map((agent) => (
            <span
              key={agent.key}
              className={`status-agent agent-${agent.key}${agent.detected ? '' : ' is-off'}`}
              title={agentTitle(agent)}
            >
              <span className="status-agent-dot" aria-hidden="true" />
              <strong>{agent.label}</strong>
            </span>
          ))}
        </div>
        <div className="status-summary">
          <span>提示词 {promptSummary}</span>
          <span>MCP {mcpSummary}</span>
        </div>
        <div className="status-meta">
          <div className="theme-switch" role="group" aria-label="主题">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={theme === option.value}
                title={option.title}
                className={theme === option.value ? 'is-active' : ''}
                onClick={() => chooseTheme(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <span className="status-version" title={health?.url ?? '本机服务'}>
            {health ? `v${health.version}` : '版本未知'}
          </span>
          <button type="button" className="status-quit" onClick={() => void quit()} disabled={quitting}>
            {quitting ? '停止中…' : '退出程序'}
          </button>
        </div>
      </footer>
      {confirmNode}
    </div>
  );
}
