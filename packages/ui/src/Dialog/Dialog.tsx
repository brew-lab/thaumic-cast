import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useId, useLayoutEffect, useRef } from 'preact/hooks';
import { Button } from '../Button';
import type { GlyphName } from '../Icon';
import { IconButton } from '../IconButton';
import styles from './Dialog.module.css';

/** The confirming action of a {@link Dialog}. */
export interface DialogConfirm {
  /** Its words: "Stop", "Disconnect". */
  label: string;
  /** A start glyph: the square for a stop. */
  glyph?: GlyphName;
  /** A destructive action: filled danger. */
  danger?: boolean;
  /** The words while it runs ("Stopping…"); without them it keeps its words. */
  busy?: string;
  /** The words after it fails ("Try again"); without them it returns to its words. */
  failed?: string;
  /**
   * The action. The Dialog closes once it resolves; if it rejects, the Dialog stays open
   * and the Button shows its failed state.
   */
  onAction: () => Promise<unknown>;
}

/** Props for {@link Dialog}. */
export interface DialogProps {
  /** Open: shown modally over the page, with the scrim behind it. */
  open: boolean;
  /** The question's title, the dialog's name: "Stop all casts". */
  title: string;
  /** What it will do, the dialog's description. */
  description?: ComponentChildren;
  /** The confirming action, last in the row. */
  confirm: DialogConfirm;
  /** Cancel's words. */
  cancelLabel: string;
  /** The Close X's name. */
  closeLabel: string;
  /**
   * Called whenever it should close: Cancel, Close, Esc, or the confirm succeeding. The
   * caller sets `open` to false.
   */
  onClose: () => void;
}

/**
 * The modal confirm (DESIGN.md C-dialog), for Stop all casts and Disconnect extensions: a native
 * `<dialog>` opened with `showModal()`, so it sits in the top layer over the `--scrim` and the page
 * behind it is inert. The title and description name and describe it; Close (the X) sits at the
 * title's end; Cancel then the confirm sit at the end of the row, md, and stack under a 25rem
 * dialog with the confirm last. Focus starts on Cancel; Esc, Close and Cancel cancel (they wait
 * while the confirm runs, so its outcome is never hidden); when it closes, focus goes back to
 * whatever opened it. The confirm is busy while it runs, closes the Dialog when it succeeds, and
 * shows its failed state, with the Dialog still open, when it fails. One kind only.
 * @param props - Component props
 * @param props.open - Open
 * @param props.title - The title
 * @param props.description - What it will do
 * @param props.confirm - The confirming action
 * @param props.cancelLabel - Cancel's words
 * @param props.closeLabel - The X's name
 * @param props.onClose - Called when it should close
 * @returns The dialog
 */
export function Dialog({
  open,
  title,
  description,
  confirm,
  cancelLabel,
  closeLabel,
  onClose,
}: DialogProps): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // While the confirm runs, Esc, Close and Cancel wait: closing then would hide its outcome.
  const running = useRef(false);
  const cancel = (): void => {
    if (!running.current) closeRef.current();
  };

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      dialog.querySelector<HTMLElement>('[data-dialog-cancel]')?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
      const back = opener.current;
      opener.current = null;
      if (back?.isConnected) back.focus();
    }
  }, [open]);

  // Esc is a cancel: the caller closes it, so `open` stays the one source of truth.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onCancel = (event: Event): void => {
      event.preventDefault();
      if (!running.current) closeRef.current();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => dialog.removeEventListener('cancel', onCancel);
  }, []);

  const run = async (): Promise<void> => {
    running.current = true;
    try {
      await confirm.onAction();
    } finally {
      running.current = false;
    }
    closeRef.current();
  };

  return (
    <dialog
      ref={ref}
      class={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
    >
      {open && (
        <div class={styles.body}>
          <div class={styles.head}>
            <h2 id={titleId} class={styles.title}>
              {title}
            </h2>
            <IconButton glyph="x" label={closeLabel} onPress={cancel} />
          </div>
          {description && (
            <p id={descriptionId} class={styles.description}>
              {description}
            </p>
          )}
          <div class={styles.actions}>
            <Button size="md" kind="outline" onClick={cancel} data-dialog-cancel="">
              {cancelLabel}
            </Button>
            <Button
              size="md"
              kind="filled"
              danger={confirm.danger}
              icon={confirm.glyph}
              onAction={run}
              labels={{ busy: confirm.busy, failed: confirm.failed }}
            >
              {confirm.label}
            </Button>
          </div>
        </div>
      )}
    </dialog>
  );
}
