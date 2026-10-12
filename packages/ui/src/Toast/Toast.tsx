import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { useAnnouncer } from '../Announcer';
import { Button } from '../Button';
import type { ActionLabels } from '../Button/action';
import { Icon } from '../Icon';
import { IconButton } from '../IconButton';
import styles from './Toast.module.css';

/** A toast's one action, only after a removal: "Undo". Its name includes the text. */
export interface ToastAction {
  /** The words: "Undo". */
  label: string;
  /** A plain action. */
  onClick?: () => void;
  /** An async action (Undo re-adds a room through Sonos), with busy and failed states. */
  onAction?: () => Promise<unknown>;
  /** The async action's busy and failed words. */
  labels?: ActionLabels;
}

/**
 * Whether an Escape belongs to something open above the page (a tooltip, a listbox, a
 * dialog), which closes first; the toast then stays.
 * @param event - The keydown
 * @returns True when the Escape is someone else's
 */
export function escapeIsTaken(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return true;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (target.closest('dialog[open], :popover-open')) return true;
  if (target instanceof HTMLSelectElement) {
    try {
      return target.matches(':open');
    } catch {
      return false;
    }
  }
  return false;
}

/** Props for {@link Toast}. */
export interface ToastProps {
  /** What happened: "Kitchen left this cast". It wraps; it is never cut off. */
  text: string;
  /** One action, only after a removal: "Undo". */
  action?: ToastAction;
  /**
   * Dismisses it: X and Esc (an Esc that closes a tooltip, a listbox or a dialog first is
   * theirs). The caller also clears it on the next action or on leaving.
   */
  onDismiss: () => void;
  /** The X's name ("Dismiss"). */
  dismissLabel?: string;
}

/**
 * Says what happened when the control that caused it has gone (DESIGN.md M-toast). It is
 * neutral (no tones) on the inverse surface, with the info glyph, a quiet action and X. It
 * lives in flow, in the StickyActionBar or the desktop's toast row, so it takes no shadow.
 * One at a time and never on a timer: it goes on the next action, Esc, X or leaving. The
 * Announcer says it once, politely; it never takes focus.
 * @param props - Component props
 * @param props.text - What happened
 * @param props.action - The one action
 * @param props.onDismiss - Dismisses it
 * @param props.dismissLabel - The X's name
 * @returns The toast
 */
export function Toast({
  text,
  action,
  onDismiss,
  dismissLabel = 'Dismiss',
}: ToastProps): JSX.Element {
  const { say } = useAnnouncer();
  useEffect(() => {
    say(text);
  }, [text, say]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !escapeIsTaken(event)) onDismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <div class={styles.toast}>
      <span class={styles.glyph}>
        <Icon glyph="info" />
      </span>
      <p class={styles.text}>{text}</p>
      {action && (
        <span class={styles.action}>
          <Button
            kind="quiet"
            aria-label={`${action.label}: ${text}`}
            onClick={action.onClick}
            onAction={action.onAction}
            labels={action.labels}
          >
            {action.label}
          </Button>
        </span>
      )}
      <span class={styles.dismiss}>
        <IconButton glyph="x" size="sm" label={dismissLabel} onPress={onDismiss} />
      </span>
    </div>
  );
}
