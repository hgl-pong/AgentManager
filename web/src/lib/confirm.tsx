import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { errorMessage } from '../api.ts';

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /**
   * Performs the write behind the question. When given, the dialog stays open across the request,
   * shows the failure inside itself, and only resolves `true` once the write succeeds — so a retry
   * never has to be re-navigated from the table or form that started it.
   */
  run?: () => Promise<void>;
}

interface AskState extends ConfirmOptions {
  /** Stable per question: a new question remounts the dialog so focus and errors start clean. */
  id: number;
  busy: boolean;
  error: string | null;
}

let openDialogs = 0;

/** True while any confirmation is on screen, so global shortcuts (Ctrl+S, …) can stand down. */
export function isConfirmOpen(): boolean {
  return openDialogs > 0;
}

/** Called by ConfirmDialog while it is mounted; returns the matching release. */
export function trackConfirmOpen(): () => void {
  openDialogs += 1;
  return () => {
    openDialogs = Math.max(0, openDialogs - 1);
  };
}

/**
 * Promise-based confirmation for flows that used to call window.confirm. Render the returned node
 * once, inside the view's root element.
 *
 * Without `run` the promise resolves as soon as the user answers, and the caller's own busy state
 * (toast, disabled buttons) reports progress for the write it performs afterwards. With `run` the
 * dialog owns that progress instead.
 */
export function useConfirmDialog(): [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [state, setState] = useState<AskState | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);
  const seq = useRef(0);

  const ask = useCallback((next: ConfirmOptions) => {
    // A second question while one is open answers the first with "no" instead of stacking dialogs.
    resolver.current?.(false);
    setState({ ...next, id: ++seq.current, busy: false, error: null });
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setState(null);
    resolve?.(value);
  }, []);

  // Leaving the page with a question open must not leave its awaiter pending forever.
  useEffect(
    () => () => {
      resolver.current?.(false);
      resolver.current = null;
    },
    [],
  );

  const confirm = useCallback(() => {
    const run = state?.run;
    if (!state) return;
    if (!run) {
      settle(true);
      return;
    }
    setState({ ...state, busy: true, error: null });
    void run().then(
      () => settle(true),
      (reason: unknown) => {
        // Keep the question open: the failed write and its retry belong next to each other.
        setState((current) => (current ? { ...current, busy: false, error: errorMessage(reason) } : current));
      },
    );
  }, [settle, state]);

  const node = state ? (
    <ConfirmDialog
      key={state.id}
      title={state.title}
      message={state.message}
      confirmLabel={state.confirmLabel ?? '确认'}
      danger={state.danger}
      busy={state.busy}
      error={state.error}
      onConfirm={confirm}
      onCancel={() => settle(false)}
    />
  ) : null;

  return [ask, node];
}
