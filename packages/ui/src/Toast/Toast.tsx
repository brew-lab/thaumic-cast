import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { useAnnouncer } from '../Announcer';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { IconButton } from '../IconButton';
import styles from './Toast.module.css';

/** Props for {@link Toast}. */
export interface ToastProps {
  /** What happened: "Kitchen left this cast". It wraps to two lines at most. */
  text: string;
  /** One action, only after a removal: "Undo". Its name includes the text. */
  action?: string;
  /** Runs the action. */
  onAction?: () => void;
  /** Dismisses it: X and Esc. The caller also clears it on the next action or on leaving. */
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
 * @param props.action - The action's words
 * @param props.onAction - Runs the action
 * @param props.onDismiss - Dismisses it
 * @param props.dismissLabel - The X's name
 * @returns The toast
 */
export function Toast({
  text,
  action,
  onAction,
  onDismiss,
  dismissLabel = 'Dismiss',
}: ToastProps): JSX.Element {
  const { say } = useAnnouncer();
  useEffect(() => {
    say(text);
  }, [text, say]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) onDismiss();
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
      {action && onAction && (
        <span class={styles.action}>
          <Button kind="quiet" aria-label={`${action}: ${text}`} onClick={onAction}>
            {action}
          </Button>
        </span>
      )}
      <span class={styles.dismiss}>
        <IconButton glyph="x" size="sm" label={dismissLabel} onPress={onDismiss} />
      </span>
    </div>
  );
}
