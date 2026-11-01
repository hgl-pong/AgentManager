import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage, isAbortError } from './api.ts';
import type {
  ConfigReport,
  HealthResponse,
  MatrixResponse,
  PromptsReport,
  PromptState,
  SettingsReport,
} from '../../shared/types.ts';
import { McpView } from './views/McpView.tsx';
import { CacheView } from './views/CacheView.tsx';
import { HooksView } from './views/HooksView.tsx';
import { PromptsView } from './views/PromptsView.tsx';
import type { PromptsHandle } from './views/PromptsView.tsx';
import { SettingsView } from './views/SettingsView.tsx';
import type { SettingsHandle } from './views/SettingsView.tsx';
import { SkillsView } from './views/SkillsView.tsx';
import { SnapshotsPanel } from './views/SnapshotsPanel.tsx';
import { useConfirmDialog } from './lib/confirm.tsx';
import { THEME_OPTIONS, applyTheme, loadTheme, rememberTheme } from './lib/theme.ts';
import type { ThemeMode } from './lib/theme.ts';

const TABS = [
  {
    key: 'skills',
    label: 'Skills',
    title: 'Skills',
    lede: '查看每个 skill 在 Claude Code、Codex、pi 中的链接状态。',
  },
  {
    key: 'mcp',
    label: 'MCP',
    title: 'MCP',
    lede: '统一维护 MCP server 源，并同步到 Claude Code、Codex 与 pi。',
  },
  {
    key: 'hooks',
    label: 'Hooks',
    title: 'Hooks',
    lede: '统一维护生命周期 hooks 源，并同步到 Claude Code 与 Codex。',
  },
  {
    key: 'prompts',
    label: '提示词',
    title: '提示词',
    lede: '维护所有 agent 共用的全局提示词。',
  },
  {
    key: 'settings',
    label: '设置',
    title: '设置',
    lede: '编辑各 agent 的用户级配置与 MCP。',
  },
  {
    key: 'cache',
    label: '缓存',
    title: '缓存',
    lede: '查看各 agent 的会话记录与缓存占用，清理后先从回收站里保留，可随时恢复。',
  },
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
  const [metaErrors, setMetaErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [quitting, setQuitting] = useState(false);

  const promptsDirty = useRef(false);
  const settingsDirty = useRef(false);
  const promptsHandle = useRef<PromptsHandle | null>(null);
  const settingsHandle = useRef<SettingsHandle | null>(null);
  const metaSeq = useRef(0);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const [ask, confirmNode] = useConfirmDialog();

  useEffect(() => {
    workspaceRef.current?.scrollTo({ top: 0 });
  }, [tab]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const loadMeta = useCallback(async (signal?: AbortSignal) => {
    const seq = ++metaSeq.current;
    const results = await Promise.allSettled([
      api.health(signal),
      api.prompts(signal),
      api.matrix(signal),
      api.settings(signal),
      api.config(signal),
    ]);
    if (seq !== metaSeq.current || signal?.aborted) return;

    const errors: string[] = [];
    const [healthResult, promptsResult, matrixResult, settingsResult, configResult] = results;
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

  function anyDirty(): boolean {
    return promptsDirty.current || settingsDirty.current;
  }

  function select(key: TabKey) {
    if (key === tab) return;
    window.location.hash = key;
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

  const settingsSaved = useCallback(() => {
    setSnapshotVersion((current) => current + 1);
    void loadMeta();
  }, [loadMeta]);

  const markPromptsDirty = useCallback((dirty: boolean) => {
    promptsDirty.current = dirty;
  }, []);

  const markSettingsDirty = useCallback((dirty: boolean) => {
    settingsDirty.current = dirty;
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
          <span className="brand-copy">
            <strong>AgentManager</strong>
            <span>本地配置</span>
          </span>
        </div>

        <nav className="side-nav" aria-label="主导航">
          <div className="nav-list" role="tablist" aria-orientation="vertical">
            {TABS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                role="tab"
                id={`nav-${entry.key}`}
                title={entry.title}
                aria-selected={entry.key === tab}
                aria-controls="workspace-panel"
                className={entry.key === tab ? 'side-link is-active' : 'side-link'}
                onClick={() => select(entry.key)}
              >
                <span className="side-link-label">{entry.label}</span>
              </button>
            ))}
          </div>
        </nav>

        <section className="side-agents" aria-labelledby="side-agents-title">
          <h2 id="side-agents-title">状态</h2>
          <div className="side-summary">
            <span>提示词 {promptSummary}</span>
            <span>MCP {mcpSummary}</span>
          </div>
          <ul>
            {agents.map((agent) => (
              <li key={agent.key} className="side-agent">
                <span className="side-agent-copy">
                  <strong>{agent.label}</strong>
                  <span>
                    {agent.detected ? '已检测' : '未检测'}
                    {agent.fileCount === null
                      ? ' · 配置文件未知'
                      : ` · ${agent.existsCount}/${agent.fileCount} 个文件`}
                    {agent.promptState ? ` · ${PROMPT_STATE_SHORT[agent.promptState]}` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {metaErrors.length > 0 && (
            <p className="side-error" title={metaErrors.join('；')}>
              部分状态读取失败{' '}
              <button type="button" className="link-button" onClick={() => void loadMeta()}>
                重试
              </button>
            </p>
          )}
        </section>

        <footer className="side-foot">
          <div className="side-version">
            <span>{health ? `v${health.version}` : '版本未知'}</span>
            <code>{health?.url ?? '本机服务'}</code>
          </div>
          <button type="button" className="secondary" onClick={() => void quit()} disabled={quitting}>
            {quitting ? '停止中…' : '退出程序'}
          </button>
        </footer>
      </aside>

      <div className="app-main">
        <header className="page-head">
          <div className="page-title">
            <h1>{activeTab.title}</h1>
            <p className="lede">{activeTab.lede}</p>
          </div>
          <div className="head-tools">
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
            <button type="button" className="primary rescan" onClick={() => void rescan()}>
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
          {tab === 'mcp' && <McpView version={dataVersion} onChanged={changed} />}
          {tab === 'hooks' && <HooksView version={dataVersion} onChanged={changed} />}
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
      {confirmNode}
    </div>
  );
}
