import { useEffect, useId, useRef, useState } from 'react';
import { api, errorMessage, isAbortError } from '../api.ts';
import { trackConfirmOpen } from '../lib/confirm.tsx';
import { categoryLabel, pick, riskLabel, STORE_TEXT } from '../lib/store-i18n.ts';
import type { StoreLang } from '../lib/store-i18n.ts';
import type {
  StoreMcpOption,
  StoreMcpServer,
  StoreSkill,
  StoreSkillDetail,
} from '../../../shared/types.ts';

export type StoreDetailTarget =
  | { kind: 'skill'; item: StoreSkill }
  | { kind: 'mcp'; item: StoreMcpServer };

function formatDate(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN');
}

function formatCount(value: number): string {
  return value.toLocaleString('zh-CN');
}

/** What a stdio option launches, or the endpoint an http/sse option connects to. */
function previewText(option: StoreMcpOption): string {
  if (option.server.transport !== 'stdio') return option.server.url ?? '';
  return [option.server.command ?? '', ...(option.server.args ?? [])].filter(Boolean).join(' ');
}

function DetailList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section className="store-detail-section">
      <h4>{title}</h4>
      <ul>
        {items.map((item, index) => (
          <li key={`${index}:${item}`}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

/** Fetches the full catalog record: the card only carries the summary line. */
function SkillDetailBody({ item, lang }: { item: StoreSkill; lang: StoreLang }) {
  const [detail, setDetail] = useState<StoreSkillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const t = (key: keyof typeof STORE_TEXT) => pick(lang, STORE_TEXT[key]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void api
      .storeSkill(item.slug, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setDetail(next);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || isAbortError(reason)) return;
        setError(errorMessage(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [item.slug, attempt]);

  const updated = formatDate(detail?.updatedAt ?? item.updatedAt);
  return (
    <>
      {item.summary !== '' && <p className="store-detail-summary">{item.summary}</p>}

      <dl className="store-detail-meta">
        {item.repository && (
          <div>
            <dt>{t('detailRepository')}</dt>
            <dd>
              <a href={item.repository} target="_blank" rel="noreferrer">
                {item.repository}
              </a>
            </dd>
          </div>
        )}
        <div>
          <dt>{t('downloads')}</dt>
          <dd>{formatCount(item.downloads)}</dd>
        </div>
        <div>
          <dt>{t('favorites')}</dt>
          <dd>{formatCount(item.favorites)}</dd>
        </div>
        {detail && detail.viewCount > 0 && (
          <div>
            <dt>{t('detailViews')}</dt>
            <dd>{formatCount(detail.viewCount)}</dd>
          </div>
        )}
        {updated && (
          <div>
            <dt>{t('updated')}</dt>
            <dd>{updated}</dd>
          </div>
        )}
      </dl>

      {loading && <p className="hint">{t('detailLoading')}</p>}
      {error && (
        <div className="error">
          {t('detailError')}
          {error}
          <button type="button" onClick={() => setAttempt((current) => current + 1)}>
            {t('retry')}
          </button>
        </div>
      )}

      {detail && (
        <>
          {detail.aiTitle && <p className="store-detail-lead">{detail.aiTitle}</p>}
          {detail.aiSummary && <p>{detail.aiSummary}</p>}
          {detail.valueStatement && <p>{detail.valueStatement}</p>}

          <DetailList title={t('detailCapabilities')} items={detail.capabilities} />
          <DetailList title={t('detailLimitations')} items={detail.limitations} />

          {detail.useCases.length > 0 && (
            <section className="store-detail-section">
              <h4>{t('detailUseCases')}</h4>
              {detail.useCases.map((useCase, index) => (
                <div className="store-detail-usecase" key={`${index}:${useCase.title}`}>
                  {useCase.title && <strong>{useCase.title}</strong>}
                  {useCase.description && <p>{useCase.description}</p>}
                </div>
              ))}
            </section>
          )}

          {detail.files.length > 0 && (
            <section className="store-detail-section">
              <h4>{t('detailFiles')}</h4>
              <ul className="store-detail-files">
                {detail.files.map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code>
                    {file.lines !== undefined && <span className="hint"> · {file.lines}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {detail.securitySummary && (
            <section className="store-detail-section">
              <h4>{t('detailSecurity')}</h4>
              <p>{detail.securitySummary}</p>
            </section>
          )}

          {detail.riskFactors.length > 0 && (
            <section className="store-detail-section">
              <h4>{t('detailRiskFactors')}</h4>
              <div className="store-badges">
                {detail.riskFactors.map((factor) => (
                  <span className="tag" key={factor}>
                    {factor}
                  </span>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}

/** The registry entry already carries everything the card needs; this lays it out in full. */
function McpDetailBody({ item, lang }: { item: StoreMcpServer; lang: StoreLang }) {
  const t = (key: keyof typeof STORE_TEXT) => pick(lang, STORE_TEXT[key]);
  const updated = formatDate(item.updatedAt);

  return (
    <>
      {item.summary !== '' && <p className="store-detail-summary">{item.summary}</p>}

      <dl className="store-detail-meta">
        <div>
          <dt>ID</dt>
          <dd>
            <code>{item.id}</code>
          </dd>
        </div>
        {item.repository && (
          <div>
            <dt>{t('detailRepository')}</dt>
            <dd>
              <a href={item.repository} target="_blank" rel="noreferrer">
                {item.repository}
              </a>
            </dd>
          </div>
        )}
        {item.websiteUrl && (
          <div>
            <dt>{t('detailWebsite')}</dt>
            <dd>
              <a href={item.websiteUrl} target="_blank" rel="noreferrer">
                {item.websiteUrl}
              </a>
            </dd>
          </div>
        )}
        {updated && (
          <div>
            <dt>{t('updated')}</dt>
            <dd>{updated}</dd>
          </div>
        )}
      </dl>

      <section className="store-detail-section">
        <h4>{t('detailOptions')}</h4>
        {item.options.length === 0 && <p className="hint">{t('detailNoOptions')}</p>}
        {item.options.map((option) => (
          <div className="store-detail-option" key={option.id}>
            <div className="store-detail-option-head">
              <span className="tag">{option.transport}</span>
              <code>{option.label}</code>
            </div>
            <code className="store-detail-command">{previewText(option)}</code>
            {option.variables.length > 0 ? (
              <ul className="store-detail-vars">
                {option.variables.map((variable) => (
                  <li key={`${variable.target}:${variable.name}`}>
                    <code>{variable.name}</code>{' '}
                    <span className="tag">{t('mcpVariableRequired')}</span>
                    {variable.description && <span className="hint"> · {variable.description}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">{t('mcpNoVariables')}</p>
            )}
          </div>
        ))}
      </section>
    </>
  );
}

/**
 * The card preview: everything the registry says about one skill or MCP server, plus the install
 * action. The card itself only has room for a summary line, so this is where the full record lives.
 */
export function StoreDetailDialog({
  target,
  lang,
  onClose,
  onInstall,
}: {
  target: StoreDetailTarget;
  lang: StoreLang;
  onClose: () => void;
  onInstall: (target: StoreDetailTarget) => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleId = `${useId()}-store-detail-title`;
  const t = (key: keyof typeof STORE_TEXT) => pick(lang, STORE_TEXT[key]);
  const { item } = target;
  const canInstall = target.kind === 'mcp' ? target.item.options.length > 0 : true;
  const owner =
    target.kind === 'skill'
      ? target.item.owner === 'unknown'
        ? target.item.slug
        : `${target.item.owner}/${target.item.slug}`
      : target.item.id;
  const installTitle = item.inSource
    ? t(target.kind === 'mcp' ? 'mcpInSourceTitle' : 'inSourceTitle')
    : !canInstall
      ? t('mcpNoOptionsTitle')
      : undefined;
  const transports =
    target.kind === 'mcp' ? [...new Set(target.item.options.map((option) => option.transport))] : [];

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    closeRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  // Global shortcuts must stand down while the preview is modal.
  useEffect(() => trackConfirmOpen(), []);

  return (
    <dialog
      ref={ref}
      className="confirm-dialog store-detail-dialog"
      data-size="lg"
      tabIndex={-1}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="store-detail-head">
        <div className="store-detail-head-main">
          <div className="store-title">
            <h2 id={titleId}>{item.name}</h2>
            <span className="store-owner">{owner}</span>
          </div>
          <div className="store-badges">
            {item.version && <span className="tag">v{item.version}</span>}
            {target.kind === 'skill' ? (
              <>
                {target.item.category && (
                  <span className="tag">{categoryLabel(lang, target.item.category)}</span>
                )}
                {target.item.risk && (
                  <span className={`tag store-risk store-risk-${target.item.risk}`}>
                    {riskLabel(lang, target.item.risk)}
                  </span>
                )}
                {target.item.quality !== undefined && (
                  <span className="tag">
                    {t('quality')} {target.item.quality}
                  </span>
                )}
                {target.item.hasScripts && <span className="tag">{t('scripts')}</span>}
                {target.item.needsNetwork && <span className="tag">{t('network')}</span>}
                {target.item.license && <span className="tag">{target.item.license}</span>}
              </>
            ) : (
              <>
                {transports.map((transport) => (
                  <span className="tag" key={transport}>
                    {transport}
                  </span>
                ))}
                {target.item.inSource && <span className="tag">{t('inSource')}</span>}
              </>
            )}
          </div>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="store-detail-close"
          aria-label={t('detailClose')}
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <div className="confirm-dialog-body store-detail-body">
        {target.kind === 'skill' ? (
          <SkillDetailBody item={target.item} lang={lang} />
        ) : (
          <McpDetailBody item={target.item} lang={lang} />
        )}
      </div>

      <div className="confirm-dialog-actions">
        <button type="button" onClick={onClose}>
          {t('detailClose')}
        </button>
        <button
          type="button"
          className="primary"
          disabled={item.inSource || !canInstall}
          title={installTitle}
          onClick={() => onInstall(target)}
        >
          {item.inSource ? t('inSource') : canInstall ? t('install') : t('mcpNoOptions')}
        </button>
      </div>
    </dialog>
  );
}
