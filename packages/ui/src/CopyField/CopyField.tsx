import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { useAnnouncer } from '../Announcer';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { IconButton } from '../IconButton';
import { cx } from '../utils/cx';
import { browserClipboard, copyPendingText, type ClipboardEnv } from './clipboard';
import { copyResultFor, shownCopyText, type CopyResult } from './result';
import { COPY_CONFIRM_MS } from '../tokens';
import styles from './CopyField.module.css';

/**
 * Selects all the text in an element, so it can be copied by hand.
 * @param el - The element, if mounted
 */
function selectAll(el: HTMLElement | null): void {
  const selection = el ? window.getSelection() : null;
  if (!el || !selection) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Props for {@link CopyField}. */
export interface CopyFieldProps {
  /**
   * The text shown, which copying never changes. Empty or missing, with no `getValue`:
   * unavailable; missing, with `getValue`: the copied text is what is shown.
   */
  value?: string;
  /**
   * Works out the text at the moment of the click, such as a URL from a refreshed address.
   * The clipboard write starts inside the click and the text follows (WebKit). A rejection
   * means there is nothing to copy yet: unavailable.
   */
  getValue?: () => Promise<string>;
  /** The action's label, which says what it copies: "Copy URL", "Copy address". */
  action: string;
  /** The done label, also said by the Announcer: "Copied". */
  done: string;
  /** The note when the clipboard refuses: "Copying did not work. The text is selected…". */
  refusedNote: string;
  /** The note while there is nothing to copy: "This computer's address is not known yet…". */
  unavailableNote: string;
  /**
   * always: the value is shown, as text, with the action beside it (the Server's Address).
   * onRefusal: the action alone, hugging its label; the value appears as text, selected,
   * only when the clipboard refuses (a card).
   */
  reveal?: 'always' | 'onRefusal';
  /** Lines under the control on what the value is for. */
  help?: ComponentChildren;
  /** Done and the revealed value go back to rest when this changes (a new value). */
  resetKey?: unknown;
  /** The clipboard to write to; the browser's by default (tests and the catalogue fake it). */
  clipboard?: ClipboardEnv;
  /**
   * How long "Copied" shows, in ms: `COPY_CONFIRM_MS` (P-copy). Only the catalogue changes
   * it, with `Infinity`, to hold the state for a screenshot.
   */
  confirmFor?: number;
}

/**
 * A value you read, and its copy action (DESIGN.md M-copy, P-copy). The value is text, not a
 * box: machine text in tabular figures that wraps anywhere and is never cut off, like any
 * other readout value. Beside it (or under it, when it does not fit) is a quiet sm Button
 * named by what it copies. The write starts inside the click; `done` ("Copied", with the
 * check) shows for `COPY_CONFIRM_MS`, then the action returns to rest, and the Announcer
 * says it once, politely. When the clipboard refuses, the value is shown if it was hidden,
 * then selected and focused, with an info note; it is not an error tint, because it is not
 * the user's to fix. Its size is sm on every surface (F-size). Under 20rem of its own
 * `field` container the action is an icon-only square, still named by its label.
 * @param props - Component props
 * @param props.value - The text shown
 * @param props.getValue - Works out the text at the click
 * @param props.action - The action's label
 * @param props.done - The done label
 * @param props.refusedNote - The note when the clipboard refuses
 * @param props.unavailableNote - The note while there is nothing to copy
 * @param props.reveal - always or onRefusal
 * @param props.help - Lines under the control
 * @param props.resetKey - Returns to rest when it changes
 * @param props.clipboard - The clipboard to write to
 * @param props.confirmFor - How long "Copied" shows
 * @returns The value and its copy action
 */
export function CopyField({
  value,
  getValue,
  action,
  done,
  refusedNote,
  unavailableNote,
  reveal = 'always',
  help,
  resetKey,
  clipboard,
  confirmFor = COPY_CONFIRM_MS,
}: CopyFieldProps): JSX.Element {
  const id = useId();
  const noteId = `${id}-note`;
  const text = useRef<HTMLSpanElement>(null);
  const [result, setResult] = useState<CopyResult>('idle');
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [copies, setCopies] = useState(0);
  const { say } = useAnnouncer();
  const nothingToCopy = !getValue && !value;

  // "Copied" is a brief echo of the user's own action (P-copy): after COPY_CONFIRM_MS the
  // action returns to its rest label. A refusal has no timer: its note needs reading.
  useEffect(() => {
    if (result !== 'done' || !Number.isFinite(confirmFor)) return undefined;
    const timer = setTimeout(() => setResult('idle'), confirmFor);
    return () => clearTimeout(timer);
  }, [result, copies, confirmFor]);

  // A new value is a new thing to copy: drop what was shown for the old one.
  useEffect(() => {
    setResult('idle');
    setCopiedText(null);
  }, [resetKey, value]);

  const copy = (): void => {
    // The write must start before anything is awaited: WebKit allows it only in the click.
    const pending = getValue ? getValue() : Promise.resolve(value ?? '');
    const settle = async (outcome: 'copied' | 'refused'): Promise<void> => {
      const copied = await pending.then(
        (t) => t || null,
        () => null,
      );
      const next = copyResultFor(outcome, copied);
      setResult(next);
      setCopiedText(copied);
      if (next === 'done') {
        setCopies((n) => n + 1);
        say(done);
      }
      if (next === 'refused') {
        say(refusedNote);
        requestAnimationFrame(() => {
          // The value is beside the action just pressed, so nothing needs scrolling to it.
          text.current?.focus({ preventScroll: true });
          selectAll(text.current);
        });
      }
      if (next === 'unavailable') say(unavailableNote);
    };
    copyPendingText(
      pending.then((t) => t || Promise.reject(new Error('Nothing to copy'))),
      clipboard ?? browserClipboard(),
    ).then(
      () => settle('copied'),
      () => settle('refused'),
    );
  };

  const shown = shownCopyText(value, copiedText);
  const showValue = (reveal === 'always' || result === 'refused') && !!shown;
  const unavailable = nothingToCopy || result === 'unavailable';
  const note = result === 'refused' ? refusedNote : unavailable ? unavailableNote : null;

  return (
    <div class={cx(styles.copy, styles[reveal])}>
      <div class={styles.line}>
        {showValue && (
          <span
            ref={text}
            class={cx(styles.value, 'mono')}
            tabIndex={-1}
            aria-describedby={note ? noteId : undefined}
          >
            {shown}
          </span>
        )}
        <span class={styles.action}>
          <Button
            kind="quiet"
            icon="copy"
            flush
            status={result === 'done' ? 'done' : 'idle'}
            labels={{ done }}
            disabled={nothingToCopy}
            onClick={copy}
          >
            {action}
          </Button>
        </span>
        {reveal === 'always' && (
          <span class={styles.square}>
            <IconButton
              glyph={result === 'done' ? 'check' : 'copy'}
              label={action}
              disabled={nothingToCopy}
              onPress={copy}
            />
          </span>
        )}
      </div>
      {note && (
        <p id={noteId} class={styles.note}>
          <span class={styles.glyph}>
            <Icon glyph="info" />
          </span>
          <span>{note}</span>
        </p>
      )}
      {help && <div class={styles.help}>{help}</div>}
    </div>
  );
}
