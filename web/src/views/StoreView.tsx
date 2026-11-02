import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorMessage, isAbortError } from '../api.ts';
import { useConfirmDialog } from '../lib/confirm.tsx';
import { StoreMcpInstallDialog } from '../components/StoreMcpInstallDialog.tsx';
import { StoreDetailDialog } from '../components/StoreDetailDialog.tsx';
import type { StoreDetailTarget } from '../components/StoreDetailDialog.tsx';
import {
  STORE_LANGS,
  STORE_TEXT,
  categoryLabel,
  loadStoreLang,
  pickFilled,
  rememberStoreLang,
  riskLabel,
} from '../lib/store-i18n.ts';
import type { StoreLang } from '../lib/store-i18n.ts';
import type {
  StoreKind,
  StoreMcpInstallResponse,
  StoreMcpServer,
  StoreReport,
  StoreSkill,
} from '../../../shared/types.ts';

const PAGE_SIZE = 24;

interface AgentOption {
  key: string;
  label: string;
  detected: boolean;
}

/** Mirrors the server's path join so the dialog can name the folder that will appear on disk. */
function joinPath(root: string, name: string): string {
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${separator}${name}`;
}

function formatCount(value: number): string {
  return value.toLocaleString('zh-CN');
}

function formatDate(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('zh-CN');
}

/** The language switch itself: 中文 / English / 双语, in whichever language is being shown. */
function langLabel(lang: StoreLang, option: StoreLang): string {
  if (option === 'zh') return '中文';
  if (option === 'en') return 'English';
  return lang === 'en' ? 'Bilingual' : '双语';
}

export function StoreView({
  version,
  agents,
  onChanged,
  onOpenSkills,
}: {
  version: number;
  agents: AgentOption[];
  onChanged: () => void;
  onOpenSkills: () => void;
}) {
  const [lang, setLang] = useState<StoreLang>(() => loadStoreLang());
  const [kind, setKind] = useState<StoreKind>('skill');
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [page, setPage] = useState(1);
  // The MCP registry pages by cursor, so the page keeps a stack of the cursors it has visited.
  const [cursor, setCursor] = useState('');
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [report, setReport] = useState<StoreReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Only a skill install can be followed up on the Skills page; MCP installs sync in place.
  const [noticeHasLinks, setNoticeHasLinks] = useState(false);
  const [installing, setInstalling] = useState<StoreMcpServer | null>(null);
  const [detail, setDetail] = useState<StoreDetailTarget | null>(null);
  // null means "follow whatever is detected": a new agent is then linked without extra clicks.
  const [targets, setTargets] = useState<string[] | null>(null);
  const seqRef = useRef(0);
  const topRef = useRef<HTMLElement | null>(null);
  const [ask, confirmNode] = useConfirmDialog();

  const t = useCallback(
    (key: keyof typeof STORE_TEXT, ...values: Array<string | number>) =>
      pickFilled(lang, STORE_TEXT[key], values),
    [lang],
  );

  /** One-off pair for text that includes a skill name, where `安装 Install latte` would read wrong. */
  const pair = useCallback(
    (zh: string, en: string) => (lang === 'zh' ? zh : lang === 'en' ? en : `${zh} / ${en}`),
    [lang],
  );

  const detected = useMemo(() => agents.filter((agent) => agent.detected), [agents]);
  const selected = targets ?? detected.map((agent) => agent.key);

  const load = useCallback(
    async (
      nextKind: StoreKind,
      nextQuery: string,
      position: { page: number; cursor: string },
      options: { refresh?: boolean } = {},
      signal?: AbortSignal,
    ) => {
      const seq = ++seqRef.current;
      setLoading(true);
      try {
        const next = await api.store(nextQuery, {
          kind: nextKind,
          ...(nextKind === 'skill' ? { page: position.page } : { cursor: position.cursor }),
          limit: PAGE_SIZE,
          refresh: options.refresh,
          signal,
        });
        if (seq !== seqRef.current) return;
        setReport(next);
        setLoadError(null);
      } catch (reason) {
        if (seq !== seqRef.current || signal?.aborted || isAbortError(reason)) return;
        setLoadError(errorMessage(reason));
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(kind, submitted, { page, cursor }, {}, controller.signal);
    return () => controller.abort();
  }, [load, kind, submitted, page, cursor, version]);

  // Changing page should start the reader at the top of the grid, not at the pager.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    topRef.current?.scrollIntoView({ block: 'start' });
  }, [page, cursor]);

  function chooseLang(next: StoreLang) {
    setLang(next);
    rememberStoreLang(next);
  }

  function chooseKind(next: StoreKind) {
    if (next === kind) return;
    setKind(next);
    setQuery('');
    setSubmitted('');
    setPage(1);
    setCursor('');
    setCursorStack([]);
    setReport(null);
    setLoadError(null);
  }

  function search(event: FormEvent) {
    event.preventDefault();
    const next = query.trim();
    // The registry ignores `search` below three characters; the hint under the header says so.
    if (kind === 'mcp' && next !== '' && next.length < 3) return;
    const resets = page !== 1 || cursor !== '' || cursorStack.length > 0;
    setPage(1);
    setCursor('');
    setCursorStack([]);
    // Asking for the same words again means "fetch it again", not "do nothing".
    if (next === submitted) {
      if (resets) return;
      void load(kind, next, { page: 1, cursor: '' }, { refresh: true });
      return;
    }
    setSubmitted(next);
  }

  function showFeatured() {
    setQuery('');
    setSubmitted('');
    setPage(1);
    setCursor('');
    setCursorStack([]);
    void load(kind, '', { page: 1, cursor: '' }, { refresh: true });
  }

  function nextMcpPage() {
    if (report?.kind !== 'mcp' || !report.nextCursor) return;
    setCursorStack((stack) => [...stack, cursor]);
    setCursor(report.nextCursor);
    setPage(1);
  }

  function prevMcpPage() {
    const stack = [...cursorStack];
    const previous = stack.pop() ?? '';
    setCursorStack(stack);
    setCursor(previous);
    setPage(1);
  }

  function toggleTarget(key: string, checked: boolean) {
    const current = selected;
    setTargets(checked ? [...new Set([...current, key])] : current.filter((entry) => entry !== key));
  }

  function requestInstall(item: StoreSkill) {
    const linkKeys = selected;
    const linkLabels = agents.filter((agent) => linkKeys.includes(agent.key)).map((agent) => agent.label);
    const destination = report ? joinPath(report.sourcePath, item.name) : item.name;
    const publisher = item.owner === 'unknown' ? item.slug : item.owner;

    setNotice(null);
    void ask({
      title: pair(`安装 ${item.name}`, `Install ${item.name}`),
      message: (
        <>
          <p>
            {t('dialogDownload', `${publisher}/${item.slug}`)}
            <br />
            <code>{destination}</code>
          </p>
          {linkLabels.length > 0 ? (
            <p>{t('dialogLinks', linkLabels.join('、'))}</p>
          ) : (
            <p>{t('dialogNoLinks')}</p>
          )}
          <p className="hint">
            {pair(
              `发布者 ${publisher} · 风险 ${riskLabel('zh', item.risk ?? 'safe')} · 质量 ${item.quality ?? '—'}`,
              `publisher ${publisher} · risk ${riskLabel('en', item.risk ?? 'safe')} · quality ${item.quality ?? '—'}`,
            )}
            {item.license ? ` · ${item.license}` : ''}
          </p>
          {item.hasScripts && <p className="warning">{t('dialogScripts')}</p>}
          <p className="hint">{t('dialogHint')}</p>
        </>
      ),
      confirmLabel: t('install'),
      run: async () => {
        setBusy(item.id);
        try {
          const result = await api.installStoreSkill({ owner: item.owner, slug: item.slug, agents: linkKeys });
          setReport((current) =>
            current?.kind === 'skill'
              ? {
                  ...current,
                  items: current.items.map((entry) =>
                    entry.id === item.id ? { ...entry, inSource: true } : entry,
                  ),
                }
              : current,
          );
          const linked = result.links.filter((link) => link.state === 'linked').map((link) => link.label);
          const parts = [
            t('noticeInstalled', result.name),
            ...(linked.length > 0 ? [t('noticeLinked', linked.join('、'))] : []),
            ...result.warnings.map((warning) => `${t('warningPrefix')}${warning}`),
            t('noticeSnapshot', result.snapshotId),
          ];
          setNotice(parts.join(' · '));
          setNoticeHasLinks(true);
          onChanged();
        } finally {
          setBusy(null);
        }
      },
    });
  }

  function installFromDetail(target: StoreDetailTarget) {
    // The preview has done its job; the install flow gets the whole screen.
    setDetail(null);
    if (target.kind === 'skill') requestInstall(target.item);
    else {
      setNotice(null);
      setInstalling(target.item);
    }
  }

  function mcpInstalled(item: StoreMcpServer, result: StoreMcpInstallResponse) {
    setInstalling(null);
    setReport((current) =>
      current?.kind === 'mcp'
        ? {
            ...current,
            items: current.items.map((entry) =>
              entry.id === item.id ? { ...entry, inSource: true } : entry,
            ),
          }
        : current,
    );
    const parts = [
      t('mcpNotice', result.name),
      ...result.warnings.map((warning) => `${t('warningPrefix')}${warning}`),
      ...(result.snapshotIds.length > 0 ? [t('noticeSnapshot', result.snapshotIds.join('、'))] : []),
    ];
    setNotice(parts.join(' · '));
    setNoticeHasLinks(false);
    onChanged();
  }

  const trimmedQuery = query.trim();
  const tooShort = kind === 'mcp' && trimmedQuery !== '' && trimmedQuery.length < 3;
  const placeholder = kind === 'mcp' ? t('mcpSearchPlaceholder') : t('searchPlaceholder');

  return (
    <section className="store-page" ref={topRef}>
      <div className="store-head">
        <form className="store-search" role="search" onSubmit={search}>
          <div className="store-kinds" role="group" aria-label="Skills / MCP">
            <button
              type="button"
              aria-pressed={kind === 'skill'}
              className={kind === 'skill' ? 'is-active' : ''}
              onClick={() => chooseKind('skill')}
            >
              {t('kindSkill')}
            </button>
            <button
              type="button"
              aria-pressed={kind === 'mcp'}
              className={kind === 'mcp' ? 'is-active' : ''}
              onClick={() => chooseKind('mcp')}
            >
              {t('kindMcp')}
            </button>
          </div>
          <input
            className="control"
            type="search"
            value={query}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="submit" className="primary" disabled={loading || tooShort}>
            {loading ? t('searching') : t('search')}
          </button>
          <button type="button" onClick={showFeatured} disabled={loading && submitted === ''}>
            {t('featured')}
          </button>
        </form>

        <div className="store-targets" role="group" aria-label={t('linkTargets')}>
          <span className="store-targets-label">{t('linkTargets')}</span>
          {agents.map((agent) => (
            <label className="check" key={agent.key}>
              <input
                type="checkbox"
                checked={selected.includes(agent.key)}
                disabled={!agent.detected}
                onChange={(event) => toggleTarget(agent.key, event.target.checked)}
              />
              {agent.label}
              {!agent.detected && <span className="tag">{t('noAgentDetected')}</span>}
            </label>
          ))}
          {detected.length === 0 && <span className="hint">{t('noAgents')}</span>}
          <div className="store-lang" role="group" aria-label={t('language')}>
            {STORE_LANGS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={lang === option}
                className={lang === option ? 'is-active' : ''}
                onClick={() => chooseLang(option)}
              >
                {langLabel(lang, option)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {tooShort && <p className="hint">{t('mcpMinChars')}</p>}

      <div className="toolbar">
        <p className="meta">
          {report ? (
            <>
              {report.provider} · <code>{report.endpoint}</code> ·{' '}
              {report.listing === 'featured' ? t('listingFeatured') : `${t('listingSearch')}「${report.query}」`} ·{' '}
              {report.total > report.items.length
                ? `${report.items.length}/${formatCount(report.total)}`
                : formatCount(report.items.length)}{' '}
              {t('results')} · {formatDate(report.fetchedAt)}
              {report.cached ? ` · ${t('cached')}` : ''}
            </>
          ) : (
            t('loading')
          )}
        </p>
        <p className="hint">
          {kind === 'mcp' ? (
            <>
              {t('mcpInstallNote')}
              <code>{report?.sourcePath ?? '~/.agents/mcp/servers.json'}</code> · {t('mcpInstallNoteTail')}
            </>
          ) : (
            <>
              {t('installNote')}
              <code>{report?.sourcePath ?? '~/.agents/skills'}</code> · {t('installNoteTail')}
            </>
          )}
        </p>
      </div>

      {report?.error && (
        <p className="warning">
          {report.stale ? t('staleError') : t('registryError')}
          {report.error}
          <button
            type="button"
            onClick={() => void load(kind, submitted, { page, cursor }, { refresh: true })}
          >
            {t('retry')}
          </button>
        </p>
      )}
      {loadError && (
        <div className="error">
          {t('loadError')}
          {loadError}
          <button
            type="button"
            onClick={() => void load(kind, submitted, { page, cursor }, { refresh: true })}
          >
            {t('retry')}
          </button>
        </div>
      )}
      {notice && (
        <p className="notice">
          {notice}
          {noticeHasLinks && (
            <button type="button" className="link-button notice-link" onClick={onOpenSkills}>
              {t('noticeCheckLinks')}
            </button>
          )}
        </p>
      )}
      {confirmNode}
      {detail && (
        <StoreDetailDialog
          target={detail}
          lang={lang}
          onClose={() => setDetail(null)}
          onInstall={installFromDetail}
        />
      )}
      {installing && (
        <StoreMcpInstallDialog
          item={installing}
          lang={lang}
          agents={agents}
          targetKeys={selected}
          onClose={() => setInstalling(null)}
          onInstalled={(result) => mcpInstalled(installing, result)}
        />
      )}

      {!report && !loadError && <p className="muted">{t('loading')}</p>}

      {report && report.items.length === 0 && !report.error && (
        <div className="mcpm-empty">
          {report.kind === 'mcp' ? (
            <>
              <p>
                {report.listing === 'search'
                  ? t('mcpEmptySearch', report.query)
                  : t('mcpEmptyRegistry')}
              </p>
              <p className="hint">{t('mcpEmptyHint')}</p>
            </>
          ) : (
            <>
              <p>
                {report.listing === 'search' ? t('emptySearch', report.query) : t('emptyRegistry')}
              </p>
              <p className="hint">{t('emptyHint')}</p>
            </>
          )}
        </div>
      )}

      {report && report.items.length > 0 && (
        <div className="store-grid">
          {report.kind === 'skill'
            ? report.items.map((item) => {
                const updated = formatDate(item.updatedAt);
                return (
                  <article
                    key={item.id}
                    className={item.inSource ? 'store-card is-installed' : 'store-card'}
                    role="button"
                    tabIndex={0}
                    title={t('detailOpen')}
                    aria-label={t('detailOpenLabel', item.name)}
                    onClick={() => setDetail({ kind: 'skill', item })}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setDetail({ kind: 'skill', item });
                      }
                    }}
                  >
                    <header>
                      <div className="store-title">
                        <h3>{item.name}</h3>
                        <span className="store-owner">
                          {item.owner === 'unknown' ? item.slug : `${item.owner}/${item.slug}`}
                        </span>
                      </div>
                      {item.version && <span className="tag">v{item.version}</span>}
                    </header>

                    <div className="store-badges">
                      {item.category && (
                        <span className="tag">{categoryLabel(lang, item.category)}</span>
                      )}
                      {item.risk && (
                        <span className={`tag store-risk store-risk-${item.risk}`}>
                          {riskLabel(lang, item.risk)}
                        </span>
                      )}
                      {item.quality !== undefined && (
                        <span className="tag" title={t('quality')}>
                          {t('quality')} {item.quality}
                        </span>
                      )}
                      {item.hasScripts && <span className="tag">{t('scripts')}</span>}
                      {item.needsNetwork && <span className="tag">{t('network')}</span>}
                    </div>

                    {item.summary !== '' && <p className="store-summary">{item.summary}</p>}

                    <footer>
                      <div className="store-stats">
                        {item.downloads > 0 && (
                          <span title={t('downloads')}>↓ {formatCount(item.downloads)}</span>
                        )}
                        {item.favorites > 0 && (
                          <span title={t('favorites')}>★ {formatCount(item.favorites)}</span>
                        )}
                        {updated && (
                          <span>
                            {t('updated')} {updated}
                          </span>
                        )}
                      </div>
                      {item.inSource ? (
                        <span className="store-action is-installed" title={t('inSourceTitle')}>
                          {t('inSource')}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="store-action"
                          disabled={busy !== null}
                          onClick={(event) => {
                            event.stopPropagation();
                            requestInstall(item);
                          }}
                        >
                          {busy === item.id ? t('installing') : t('install')}
                        </button>
                      )}
                    </footer>
                  </article>
                );
              })
            : report.items.map((item) => {
                const updated = formatDate(item.updatedAt);
                const transports = [...new Set(item.options.map((option) => option.transport))];
                const canInstall = item.options.length > 0;
                return (
                  <article
                    key={item.id}
                    className={item.inSource ? 'store-card is-installed' : 'store-card'}
                    role="button"
                    tabIndex={0}
                    title={t('detailOpen')}
                    aria-label={t('detailOpenLabel', item.name)}
                    onClick={() => setDetail({ kind: 'mcp', item })}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setDetail({ kind: 'mcp', item });
                      }
                    }}
                  >
                    <header>
                      <div className="store-title">
                        <h3>{item.name}</h3>
                        <span className="store-owner">{item.id}</span>
                      </div>
                      {item.version && <span className="tag">v{item.version}</span>}
                    </header>

                    <div className="store-badges">
                      {transports.map((transport) => (
                        <span className="tag" key={transport}>
                          {transport}
                        </span>
                      ))}
                    </div>

                    {item.summary !== '' && <p className="store-summary">{item.summary}</p>}

                    <footer>
                      <div className="store-stats">
                        {updated && (
                          <span>
                            {t('updated')} {updated}
                          </span>
                        )}
                      </div>
                      {item.inSource ? (
                        <span className="store-action is-installed" title={t('mcpInSourceTitle')}>
                          {t('inSource')}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="store-action"
                          disabled={!canInstall}
                          title={canInstall ? undefined : t('mcpNoOptionsTitle')}
                          onClick={(event) => {
                            event.stopPropagation();
                            setNotice(null);
                            setInstalling(item);
                          }}
                        >
                          {canInstall ? t('install') : t('mcpNoOptions')}
                        </button>
                      )}
                    </footer>
                  </article>
                );
              })}
        </div>
      )}

      {report?.kind === 'skill' && report.totalPages > 1 && (
        <nav className="store-pager" aria-label={t('pageOf', report.page, report.totalPages)}>
          <button
            type="button"
            disabled={loading || report.page <= 1}
            onClick={() => setPage(Math.max(1, report.page - 1))}
          >
            {t('prevPage')}
          </button>
          <span className="store-pager-label">{t('pageOf', report.page, report.totalPages)}</span>
          <button
            type="button"
            disabled={loading || report.page >= report.totalPages}
            onClick={() => setPage(Math.min(report.totalPages, report.page + 1))}
          >
            {t('nextPage')}
          </button>
        </nav>
      )}

      {report?.kind === 'mcp' && (report.items.length > 0 || cursorStack.length > 0) && (
        <nav className="store-pager" aria-label={t('mcpPage', cursorStack.length + 1)}>
          <button type="button" disabled={loading || cursorStack.length === 0} onClick={prevMcpPage}>
            {t('prevPage')}
          </button>
          <span className="store-pager-label">{t('mcpPage', cursorStack.length + 1)}</span>
          <button type="button" disabled={loading || !report.nextCursor} onClick={nextMcpPage}>
            {t('nextPage')}
          </button>
        </nav>
      )}
    </section>
  );
}
