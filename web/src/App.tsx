import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { PromptsView } from './views/PromptsView.tsx';
import { SettingsView } from './views/SettingsView.tsx';
import { SkillsView } from './views/SkillsView.tsx';
import { SnapshotsPanel } from './views/SnapshotsPanel.tsx';

const TABS = [
  { key: 'skills', label: 'skills' },
  { key: 'prompts', label: '提示词' },
  { key: 'settings', label: 'settings / MCP' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

function tabFromHash(): TabKey {
  const hash = window.location.hash.replace('#', '');
  const match = TABS.find((entry) => entry.key === hash);
  return match ? match.key : 'skills';
}

export default function App() {
  const [tab, setTab] = useState<TabKey>(tabFromHash);
  const [version, setVersion] = useState(0);
  const [summary, setSummary] = useState<{ prompts: string; mcp: number } | null>(null);

  useEffect(() => {
    const onHashChange = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    Promise.all([api.prompts(), api.config()])
      .then(([prompts, config]) => {
        const synced = prompts.targets.filter((target) => target.state === 'synced').length;
        setSummary({
          prompts: prompts.source.exists ? `${synced}/${prompts.targets.length} 同步` : '源未建立',
          mcp: config.servers.length,
        });
      })
      .catch(() => setSummary(null));
  }, [version]);

  const select = (key: TabKey) => {
    setTab(key);
    window.location.hash = key;
  };

  const changed = () => setVersion((current) => current + 1);

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>AgentManager</h1>
          {summary && (
            <p className="meta">
              提示词 {summary.prompts} · MCP {summary.mcp} 个 server · 每次打开都重新扫描
            </p>
          )}
        </div>
        <nav className="tabs">
          {TABS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={entry.key === tab ? 'tab active' : 'tab'}
              onClick={() => select(entry.key)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
      </header>

      {tab === 'skills' && <SkillsView version={version} onChanged={changed} />}
      {tab === 'prompts' && <PromptsView version={version} onChanged={changed} />}
      {tab === 'settings' && <SettingsView version={version} />}

      <SnapshotsPanel version={version} onRestored={changed} />
    </main>
  );
}
