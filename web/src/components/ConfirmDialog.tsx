import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { trackConfirmOpen } from '../lib/confirm.tsx';

export interface ConfirmDialogProps {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  /** True for actions that delete something: focus starts on cancel and the confirm verb turns red. */
  danger?: boolean;
  /** Failure from the run this dialog started; shown inside it instead of behind the backdrop. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A modal confirmation that appears where the eye is, unlike an inline bar rendered at the top of a
 * section. Escape and a backdrop click cancel it; destructive actions focus "cancel" first so a
 * stray Enter never deletes anything.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busy = false,
  danger = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const titleId = `${useId()}-confirm-title`;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    // showModal focuses the first focusable child; pick the safe one explicitly instead.
    (danger ? cancelRef : confirmRef).current?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [danger]);

  // While this dialog is mounted the page behind it must not act on global shortcuts.
  useEffect(() => trackConfirmOpen(), []);

  useEffect(() => {
    if (!busy) return;
    ref.current?.focus();
  }, [busy]);

  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      tabIndex={-1}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={(event) => {
        if (event.target === ref.current && !busy) onCancel();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      <div className="confirm-dialog-body">{message}</div>
      {error && (
        <p className="confirm-dialog-error" role="alert">
          {error}
        </p>
      )}
      <div className="confirm-dialog-actions">
        <button ref={cancelRef} type="button" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button
          ref={confirmRef}
          type="button"
          className={danger ? 'danger' : 'primary'}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? '执行中…' : error ? '重试' : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
