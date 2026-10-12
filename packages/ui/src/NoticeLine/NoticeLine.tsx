import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useId, useState } from 'preact/hooks';
import { useAnnouncer } from '../Announcer';
import { Button } from '../Button';
import type { ActionLabels } from '../Button/action';
import { Icon } from '../Icon';
import { IconButton } from '../IconButton';
import { noticeAnnouncement, TONE_GLYPH, type NoticeTone } from '../Notice/tone';
import { cx } from '../utils/cx';
import styles from './NoticeLine.module.css';

/** Props for {@link NoticeLine}. */
export interface NoticeLineProps {
  /** info, warning or danger (annex 2's `neutral` is `info`). */
  tone: NoticeTone;
  /** history: the away line's glyph, which stands for "while you were away". */
  glyph?: 'history';
  /** The lead, in 600: 34 characters or fewer. */
  lead: string;
  /** The text, in 400, after the lead on the same line. */
  text?: string;
  /** Spoken before the lead and never shown: "While you were away:". */
  srPrefix?: string;
  /** One action: "Try again", an outline Button re-pointed to the line's ink. */
  action?: {
    /** The words. */
    label: string;
    /** A plain action. */
    onClick?: () => void;
    /** An async action. */
    onAction?: () => Promise<unknown>;
    /** Its busy and failed words. */
    labels?: ActionLabels;
  };
  /** "Details" or "{{count}} more", opening in place under a hairline. */
  details?: {
    /** The button's words. */
    label: string;
    /** What opens. */
    content: ComponentChildren;
    /** Open, when the caller holds the state. */
    open?: boolean;
    /** Called with the new state. */
    onOpenChange?: (open: boolean) => void;
  };
  /**
   * The slot line on a compact cast: the whole line is a button that opens the cast, with
   * the chevron at the end, and no X.
   */
  opensTile?: {
    /** Opens the cast. */
    onOpen: () => void;
    /** Its name: "{{lead}}: open this cast". */
    label: string;
  };
  /** Dismisses it, only when that has no consequence (P-x). */
  onDismiss?: () => void;
  /** The X's name ("Dismiss"). */
  dismissLabel?: string;
  /** Say it through the Announcer when it arrives after open (the default). */
  announce?: boolean;
  /** Say it urgently: a room's failure line and the CastBar line only (S6, S8). */
  urgent?: boolean;
}

/**
 * One item, one row (DESIGN.md M-noticeline): a message at its source when a Notice would be
 * too much. Five uses: the row line, the tile note, the CastBar line, the slot line and the
 * away line. The words wrap and never truncate. No role of its own: an arrival after open is
 * said once by the Announcer, urgently only for a row or CastBar failure.
 * @param props - Component props
 * @param props.tone - info, warning or danger
 * @param props.glyph - history, for the away line
 * @param props.lead - The lead
 * @param props.text - The text
 * @param props.srPrefix - Spoken before the lead
 * @param props.action - One action
 * @param props.details - Details, opening in place
 * @param props.opensTile - The slot line: opens the cast
 * @param props.onDismiss - Dismisses it
 * @param props.dismissLabel - The X's name
 * @param props.announce - Say it on arrival
 * @param props.urgent - Say it urgently
 * @returns The line
 */
export function NoticeLine({
  tone,
  glyph,
  lead,
  text,
  srPrefix,
  action,
  details,
  opensTile,
  onDismiss,
  dismissLabel = 'Dismiss',
  announce = true,
  urgent = false,
}: NoticeLineProps): JSX.Element {
  const id = useId();
  const [ownOpen, setOwnOpen] = useState(false);
  const open = details?.open ?? ownOpen;
  const { say } = useAnnouncer();
  const said = noticeAnnouncement({ lead, text, prefix: srPrefix, urgent });
  useEffect(() => {
    if (announce && said) say(said.message, { urgent: said.urgent });
  }, [announce, said?.message, said?.urgent, say]);

  const toggle = (): void => {
    const next = !open;
    setOwnOpen(next);
    details?.onOpenChange?.(next);
  };

  const words = (
    <span class={styles.words}>
      {srPrefix && <span class="visually-hidden">{srPrefix} </span>}
      <span id={`${id}-lead`} class={styles.lead}>
        {lead}
      </span>
      {text && <span class={styles.text}> {text}</span>}
    </span>
  );
  const mark = (
    <span class={styles.glyph}>
      <Icon glyph={glyph ?? TONE_GLYPH[tone]} />
    </span>
  );

  if (opensTile) {
    return (
      <div class={cx(styles.line, styles[tone])}>
        <button
          type="button"
          class={styles.opener}
          aria-label={opensTile.label}
          onClick={opensTile.onOpen}
        >
          {mark}
          {words}
          <span class={styles.chevron}>
            <Icon glyph="chevron-down" />
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      class={cx(styles.line, styles[tone], onDismiss && styles.dismissible)}
      role={srPrefix ? 'group' : undefined}
      aria-label={srPrefix ? `${srPrefix} ${lead}` : undefined}
    >
      <div class={styles.row}>
        {mark}
        {words}
        {(action || details) && (
          <span class={styles.trail}>
            {action && (
              <Button
                kind="outline"
                onClick={action.onClick}
                onAction={action.onAction}
                labels={action.labels}
              >
                {action.label}
              </Button>
            )}
            {details && (
              <Button kind="quiet" expanded={open} onClick={toggle}>
                {details.label}
              </Button>
            )}
          </span>
        )}
        {onDismiss && (
          <span class={styles.dismiss}>
            <IconButton glyph="x" size="sm" label={dismissLabel} onPress={onDismiss} />
          </span>
        )}
      </div>
      {details && open && <div class={styles.details}>{details.content}</div>}
    </div>
  );
}
