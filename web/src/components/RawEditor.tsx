import { useId, useMemo, useState } from 'react';
import type { SettingsFileState } from '../../../shared/types.ts';
import {
  MASK,
  maskSettingsText,
  parseSettingsText,
  textHasSecrets,
} from '../lib/settings.ts';

export interface RawEditorProps {
  file: SettingsFileState;
  /** The canonical text shown for the current draft (raw text, or serialized form data). */
  text: string;
  sensitivePaths: ReadonlySet<string>;
  dirty: boolean;
  busy: boolean;
  error?: string | null;
  notice?: string | null;
  formLabel?: string | null;
  onUseForm?: () => void;
  onChangeText: (text: string) => void;
  onFormat: () => void;
  onReload: () => void;
}

export function RawEditor({
  file,
  text,
  sensitivePaths,
  dirty,
  busy,
  error,
  notice,
  formLabel,
  onUseForm,
  onChangeText,
  onFormat,
  onReload,
}: RawEditorProps) {
  const [showRaw, setShowRaw] = useState(false);
  const id = useId();
  const maskedText = useMemo(
    () => maskSettingsText(file.format, text, sensitivePaths),
    [file.format, text, sensitivePaths],
  );
  const parsed = useMemo(() => parseSettingsText(file.format, text), [file.format, text]);
  const secrets = useMemo(() => textHasSecrets(text) || maskedText !== text, [text, maskedText]);

  return (
    <article className={`card raw-card${dirty ? ' is-dirty' : ''}`}>
      <div className="raw-head">
        <div>
          <h2>{file.label}</h2>
          <p className="meta">
            <code>{file.id}</code> · {file.format.toUpperCase()} ·{' '}
            {file.exists ? `${file.bytes ?? '?'} 字节` : '文件尚不存在'}
            {file.role ? ` · ${file.role}` : ''}
          </p>
          <p className="path">
            <code>{file.path}</code>
          </p>
        </div>
        <div className="raw-badges">
          {dirty && <span className="tag dirty">未保存</span>}
          {parsed.ok ? (
            <span className="badge state-synced">解析正常</span>
          ) : (
            <span className="badge state-broken">解析失败</span>
          )}
        </div>
      </div>

      {file.parseError && (
        <p className="warning">读取时解析失败：{file.parseError}</p>
      )}
      {!parsed.ok && <p className="field-error">当前文本无法解析：{parsed.error}</p>}
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice inline">{notice}</p>}

      <div className="raw-toolbar">
        <label className="check">
          <input
            type="checkbox"
            checked={showRaw}
            disabled={busy}
            onChange={(event) => setShowRaw(event.target.checked)}
          />
          <span>显示原文</span>
        </label>
        {formLabel && onUseForm && (
          <button type="button" className="secondary" disabled={busy || !parsed.ok} onClick={onUseForm}>
            使用{formLabel}
          </button>
        )}
        <button type="button" className="secondary" disabled={busy} onClick={onFormat}>
          格式化
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onReload}>
          重新加载
        </button>
        {!showRaw && secrets && (
          <span className="hint">预览已遮罩（{MASK}），文件里仍是明文；打开「显示原文」后才可编辑。</span>
        )}
      </div>

      <label className="sr-only" htmlFor={id}>
        {file.label} 原始文本
      </label>
      <textarea
        id={id}
        className={`raw-editor mono-input${showRaw ? '' : ' is-masked'}`}
        rows={14}
        value={showRaw ? text : maskedText}
        readOnly={!showRaw}
        disabled={busy}
        spellCheck={false}
        aria-readonly={!showRaw}
        placeholder={file.format === 'toml' ? '在此编辑 TOML…' : '在此编辑 JSON…'}
        onChange={(event) => {
          if (showRaw) onChangeText(event.target.value);
        }}
      />
      <p className="meta">
        {showRaw
          ? '直接编辑原文。切换回表单前会先解析；解析失败不会切换，也不会丢失原文。'
          : '只读遮罩预览。敏感字段与原文件里的密钥不会被渲染到可编辑区域。'}
      </p>
    </article>
  );
}
