import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { BUSY_MIN_MS } from '../tokens';

/** Where an async action is: idle, busy, then done or failed (DESIGN.md A-button). */
export type ActionStatus = 'idle' | 'busy' | 'done' | 'failed';

/** The words a Button shows while busy and after its action settles. */
export interface ActionLabels {
  /** Shown while the action runs, e.g. "Connecting…". Defaults to the label. */
  busy?: string;
  /** Shown after it succeeds, e.g. "Connected". Without it the Button returns to idle. */
  done?: string;
  /** Shown after it fails, e.g. "Try again". Without it the Button returns to idle. */
  failed?: string;
}

/**
 * The status an action settles in. Done and failed are shown only when the Button has words
 * for them; Stop and Stop all casts have busy only, because on success the control goes away
 * and a failure is a notice at its source.
 * @param outcome - Whether the action resolved or rejected
 * @param labels - The Button's state labels
 * @returns The status to show
 */
export function settledStatus(
  outcome: 'resolved' | 'rejected',
  labels: ActionLabels = {},
): ActionStatus {
  if (outcome === 'resolved') return labels.done ? 'done' : 'idle';
  return labels.failed ? 'failed' : 'idle';
}

/**
 * How much longer a busy state must show, so it never flickers (`BUSY_MIN_MS`).
 * @param startedAt - When the action started, in ms
 * @param now - The time now, in ms
 * @param minimum - The shortest busy state, in ms
 * @returns The time left to wait, in ms (0 when none)
 */
export function remainingBusyMs(startedAt: number, now: number, minimum = BUSY_MIN_MS): number {
  return Math.max(0, minimum - (now - startedAt));
}

/**
 * The label a Button shows for a status.
 * @param status - The action status
 * @param label - The idle label
 * @param labels - The state labels
 * @returns The current label
 */
export function labelFor(status: ActionStatus, label: string, labels: ActionLabels = {}): string {
  if (status === 'busy') return labels.busy ?? label;
  if (status === 'done') return labels.done ?? label;
  if (status === 'failed') return labels.failed ?? label;
  return label;
}

/** Options for {@link useAction}. */
export interface UseActionOptions {
  /** The state labels; done and failed show only when given. */
  labels?: ActionLabels;
  /** Done and failed return to idle when this changes. There are no timers. */
  resetKey?: unknown;
  /** Says a result (the Announcer's `say`). */
  say?: (message: string) => void;
}

/**
 * Runs a Button's async action: busy for at least `BUSY_MIN_MS`, then done or failed until
 * the next press or a change of `resetKey`. A press while busy does nothing. The result is
 * said through `say`, never by a live region inside the Button.
 * @param action - The async action, if any
 * @param options - Labels, reset key and announcer
 * @param options.labels - The state labels
 * @param options.resetKey - Returns done or failed to idle when it changes
 * @param options.say - Says a result
 * @returns The status and a function that runs the action
 */
export function useAction(
  action: (() => Promise<unknown>) | undefined,
  { labels, resetKey, say }: UseActionOptions = {},
): { status: ActionStatus; run: () => void } {
  const [status, setStatus] = useState<ActionStatus>('idle');
  const busy = useRef(false);
  const live = useRef(true);
  const latest = useRef({ action, labels, say });
  latest.current = { action, labels, say };

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!busy.current) setStatus('idle');
  }, [resetKey]);

  const run = useCallback(() => {
    const current = latest.current.action;
    if (!current || busy.current) return;
    busy.current = true;
    setStatus('busy');
    const startedAt = Date.now();
    const settle = async (outcome: 'resolved' | 'rejected'): Promise<void> => {
      const wait = remainingBusyMs(startedAt, Date.now());
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      busy.current = false;
      if (!live.current) return;
      const { labels: words, say: tell } = latest.current;
      const next = settledStatus(outcome, words);
      setStatus(next);
      if (next === 'done' && words?.done) tell?.(words.done);
      if (next === 'failed' && words?.failed) tell?.(words.failed);
    };
    current().then(
      () => settle('resolved'),
      () => settle('rejected'),
    );
  }, []);

  return { status, run };
}
