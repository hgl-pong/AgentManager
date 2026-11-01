import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorMessage, isAbortError } from '../api.ts';
import { useConfirmDialog } from '../lib/confirm.tsx';
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
import type { StoreReport, StoreSkill } from '../../../shared/types.ts';

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
}: {
  version: number;
  agents: AgentOption[];
  onChanged: () => void;
}) {
  const [lang, setLang] = useState<StoreLang>(() => loadStoreLang());
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [page, setPage] = useState(1);
  const [report, setReport] = useState<StoreReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
      nextQuery: string,
      nextPage: number,
      options: { refresh?: boolean } = {},
      signal?: AbortSignal,
    ) => {
      const seq = ++seqRef.current;
      setLoading(true);
      try {
        const next = await api.store(nextQuery, {
          page: nextPage,
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
    void load(submitted, page, {}, controller.signal);
    return () => controller.abort();
  }, [load, submitted, page, version]);

  // Changing page should start the reader at the top of the grid, not at the pager.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    topRef.current?.scrollIntoView({ block: 'start' });
  }, [page]);

  function chooseLang(next: StoreLang) {
    setLang(next);
    rememberStoreLang(next);
  }

  function search(event: FormEvent) {
    event.preventDefault();
    const next = query.trim();
    // Asking for the same words again means "fetch it again", not "do nothing".
    if (next === submitted) {
      if (page !== 1) setPage(1);
      else void load(next, 1, { refresh: true });
      return;
    }
    setSubmitted(next);
    setPage(1);
  }

  function showFeatured() {
    setQuery('');
    setSubmitted('');
    setPage(1);
    void load('', 1, { refresh: true });
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
            current === null
              ? current
              : {
                  ...current,
                  items: current.items.map((entry) =>
                    entry.id === item.id ? { ...entry, inSource: true } : entry,
                  ),
                },
          );
          const linked = result.links.filter((link) => link.state === 'linked').map((link) => link.label);
          const parts = [
            t('noticeInstalled', result.name),
            ...(linked.length > 0 ? [t('noticeLinked', linked.join('、'))] : []),
            ...result.warnings.map((warning) => `${t('warningPrefix')}${warning}`),
            t('noticeSnapshot', result.snapshotId),
          ];
          setNotice(parts.join(' · '));
          onChanged();
        } finally {
          setBusy(null);
        }
      },
    });
  }

  return (
    <section className="store-page" ref={topRef}>
      <div className="store-head">
        <form className="store-search" role="search" onSubmit={search}>
          <input
            className="control"
            type="search"
            value={query}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="submit" className="primary" disabled={loading}>
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
          {t('installNote')}
          <code>{report?.sourcePath ?? '~/.agents/skills'}</code> · {t('installNoteTail')}
        </p>
      </div>

      {report?.error && (
        <p className="warning">
          {report.stale ? t('staleError') : t('registryError')}
          {report.error}
          <button type="button" onClick={() => void load(submitted, report?.page ?? 1, { refresh: true })}>
            {t('retry')}
          </button>
        </p>
      )}
      {loadError && (
        <div className="error">
          {t('loadError')}
          {loadError}
          <button type="button" onClick={() => void load(submitted, report?.page ?? 1, { refresh: true })}>
            {t('retry')}
          </button>
        </div>
      )}
      {notice && <p className="notice">{notice}</p>}
      {confirmNode}

      {!report && !loadError && <p className="muted">{t('loading')}</p>}

      {report && report.items.length === 0 && !report.error && (
        <div className="mcpm-empty">
          <p>
            {report.listing === 'search' ? t('emptySearch', report.query) : t('emptyRegistry')}
          </p>
          <p className="hint">{t('emptyHint')}</p>
        </div>
      )}

      {report && report.items.length > 0 && (
        <div className="store-grid">
          {report.items.map((item) => {
            const updated = formatDate(item.updatedAt);
            return (
              <article key={item.id} className={item.inSource ? 'store-card is-installed' : 'store-card'}>
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
                  <button
                    type="button"
                    className={item.inSource ? 'store-action is-installed' : 'store-action'}
                    disabled={item.inSource || busy !== null}
                    title={item.inSource ? t('inSourceTitle') : undefined}
                    onClick={() => requestInstall(item)}
                  >
                    {item.inSource ? t('inSource') : busy === item.id ? t('installing') : t('install')}
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      )}

      {report && report.totalPages > 1 && (
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
    </section>
  );
}
