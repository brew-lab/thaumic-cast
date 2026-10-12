import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useId, useState } from 'preact/hooks';
import { useAnnouncer } from '../Announcer';
import { Button } from '../Button';
import type { ActionLabels } from '../Button/action';
import { Icon } from '../Icon';
import { IconButton } from '../IconButton';
import { cx } from '../utils/cx';
import { noticeAnnouncement, TONE_GLYPH, type NoticeTone } from './tone';
import styles from './Notice.module.css';

export type { NoticeTone } from './tone';

/** A notice's one action: an outline Button re-pointed to the notice's ink. */
export interface NoticeAction {
  /** The words: "Try again", "Update desktop app", "Open settings". */
  label: string;
  /** A plain action. */
  onClick?: () => void;
  /** An async action, with busy and failed states. */
  onAction?: () => Promise<unknown>;
  /** The async action's busy and failed words. */
  labels?: ActionLabels;
}

/** A notice's details: a quiet "Details" button that opens more words in place. */
export interface NoticeDetails {
  /** The button's words: "Details", "{{count}} more". */
  label: string;
  /** What opens, under a hairline in the same box. */
  content: ComponentChildren;
  /** Open, when the caller holds the state. */
  open?: boolean;
  /** Called with the new state. */
  onOpenChange?: (open: boolean) => void;
}

/** Props for {@link Notice}. */
export interface NoticeProps {
  /**
   * banner: page level, under the header, at most one, a `region` named by its lead.
   * section: under a section heading or first in a slot, a `<section>` named by its lead.
   */
  kind?: 'banner' | 'section';
  /** danger, warning or info: the container, the glyph and the lead say it together. */
  tone: NoticeTone;
  /** The lead, in 600: 34 characters or fewer, no internal nouns. */
  lead?: string;
  /** The text, in 400. */
  text?: string;
  /** One action. */
  action?: NoticeAction;
  /** "Details", opening in place. */
  details?: NoticeDetails;
  /**
   * Dismisses it. Only for a dismiss with no consequence, where the fact lives on elsewhere
   * (P-x); a danger notice that blocks has none. Esc never dismisses.
   */
  onDismiss?: () => void;
  /** The X's name ("Dismiss"). */
  dismissLabel?: string;
  /** Banner only: one more current condition, folded in as its lead under a hairline. */
  also?: string;
  /**
   * Say it through the Announcer when it arrives after the surface opened (the default).
   * Nothing is said for what is already there on open.
   */
  announce?: boolean;
  /**
   * Its place in a list of notices (1 for the first), for the entrance stagger where the
   * browser has no `sibling-index()`. Leave it out for a notice on its own.
   */
  index?: number;
}

/**
 * A message bigger than a line (DESIGN.md M-notice). It absorbs Alert, SpeakerNotices and
 * the connection banner. There is no `role="alert"`: when it arrives after the surface
 * opened, the Announcer says the lead and the text once (a danger banner urgently, the rest
 * politely). The tone is never colour alone: the container, the glyph and the lead's words
 * say it together. Its Buttons and X are re-pointed to the on-container ink, and the ring
 * gap to the fill. Under 25rem of its own `notice` container the action goes under the text;
 * from 25rem it sits beside it. Focus order: the action, Details, then X.
 * @param props - Component props
 * @param props.kind - banner or section
 * @param props.tone - danger, warning or info
 * @param props.lead - The lead
 * @param props.text - The text
 * @param props.action - One action
 * @param props.details - Details, opening in place
 * @param props.onDismiss - Dismisses it
 * @param props.dismissLabel - The X's name
 * @param props.also - Banner only: one more condition
 * @param props.announce - Say it on arrival
 * @param props.index - Its place in a list of notices
 * @returns The notice
 */
export function Notice({
  kind = 'section',
  tone,
  lead,
  text,
  action,
  details,
  onDismiss,
  dismissLabel = 'Dismiss',
  also,
  announce = true,
  index,
}: NoticeProps): JSX.Element {
  const id = useId();
  const nameId = lead ? `${id}-lead` : `${id}-text`;
  const detailsId = `${id}-details`;
  const [ownOpen, setOwnOpen] = useState(false);
  const open = details?.open ?? ownOpen;
  const { say } = useAnnouncer();

  const said = noticeAnnouncement({ lead, text, urgent: kind === 'banner' && tone === 'danger' });
  useEffect(() => {
    if (announce && said) say(said.message, { urgent: said.urgent });
  }, [announce, said?.message, said?.urgent, say]);

  const toggle = (): void => {
    const next = !open;
    setOwnOpen(next);
    details?.onOpenChange?.(next);
  };

  const Root = kind === 'banner' ? 'div' : 'section';
  return (
    <Root
      class={cx(styles.notice, styles[kind], onDismiss && styles.dismissible)}
      data-tone={tone}
      style={index === undefined ? undefined : { '--i': index }}
      role={kind === 'banner' ? 'region' : undefined}
      aria-labelledby={lead || text ? nameId : undefined}
    >
      <span class={styles.glyph}>
        <Icon glyph={TONE_GLYPH[tone]} />
      </span>
      <div class={styles.body}>
        <div class={styles.words}>
          {lead && (
            <p id={`${id}-lead`} class={styles.lead}>
              {lead}
            </p>
          )}
          {text && (
            <p id={`${id}-text`} class={styles.text}>
              {text}
            </p>
          )}
        </div>
        {(action || details) && (
          <div class={styles.actions}>
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
              <Button
                kind="quiet"
                expanded={open}
                aria-describedby={lead ? `${id}-lead` : undefined}
                onClick={toggle}
              >
                {details.label}
              </Button>
            )}
          </div>
        )}
      </div>
      {onDismiss && (
        <span class={styles.dismiss}>
          <IconButton glyph="x" size="sm" label={dismissLabel} onPress={onDismiss} />
        </span>
      )}
      {details && open && (
        <div id={detailsId} class={styles.details}>
          {details.content}
        </div>
      )}
      {kind === 'banner' && also && <p class={styles.also}>{also}</p>}
    </Root>
  );
}
