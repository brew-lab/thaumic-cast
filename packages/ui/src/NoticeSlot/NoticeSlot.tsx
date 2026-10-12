import type { JSX } from 'preact';
import type { NoticeAction, NoticeDetails, NoticeTone } from '../Notice';
import { Notice } from '../Notice';
import { NoticeLine } from '../NoticeLine';
import styles from './NoticeSlot.module.css';

/** One thing wrong with a cast, already placed, deduped, suppressed and ordered (P-notices). */
export interface NoticeSlotItem {
  /** Its identity: an item is said once, and a dismissed one never again. */
  id: string;
  /** warning or danger (info for the rare neutral item). */
  tone: NoticeTone;
  /** The lead: "Kitchen cut out". */
  lead: string;
  /** The remedy: "Raise the speaker head start to 1200 ms." */
  text?: string;
  /** One action. */
  action?: NoticeAction;
  /** Details, opening in place: the shipped message. */
  details?: NoticeDetails;
  /** Dismisses it, only when that has no consequence (its Badge stays). */
  onDismiss?: () => void;
}

/** Props for {@link NoticeSlot}. */
export interface NoticeSlotProps {
  /**
   * The items, in slot order: may cut out soon › cut out › capture health › gaps › may cut
   * out in 10 min or less. Nothing from the quiet tier ever arrives here.
   */
  items: NoticeSlotItem[];
  /** On a compact tile: one slot line holding the first lead, which opens the tile. */
  compact?: boolean;
  /** Opens the tile (compact). */
  onOpenTile?: () => void;
  /** The slot line's name: "{{lead}}: open this cast". */
  openLabel?: (lead: string) => string;
  /** The X's name ("Dismiss"). */
  dismissLabel?: string;
}

/**
 * Everything wrong with one cast, at that cast (DESIGN.md C-noticeslot). The first item is a
 * Notice (section) in full; every other item is one NoticeLine named by its lead, its words
 * opening in place under Details. On a compact tile the slot is one slot line that opens the
 * tile. It is not a live region: each new item is said once by the Announcer, politely, in
 * slot order, and the items arrive with the notices' staggered entrance (`data-notices`).
 * @param props - Component props
 * @param props.items - The items, in order
 * @param props.compact - One slot line
 * @param props.onOpenTile - Opens the tile
 * @param props.openLabel - The slot line's name
 * @param props.dismissLabel - The X's name
 * @returns The slot, or nothing when there is nothing wrong
 */
export function NoticeSlot({
  items,
  compact = false,
  onOpenTile,
  openLabel = (lead) => lead,
  dismissLabel,
}: NoticeSlotProps): JSX.Element | null {
  const [first, ...rest] = items;
  if (!first) return null;
  if (compact) {
    return (
      <div class={styles.slot} data-notices="">
        <NoticeLine
          tone={first.tone}
          lead={first.lead}
          opensTile={{ onOpen: () => onOpenTile?.(), label: openLabel(first.lead) }}
        />
      </div>
    );
  }
  return (
    <div class={styles.slot} data-notices="">
      <Notice
        kind="section"
        tone={first.tone}
        lead={first.lead}
        text={first.text}
        action={first.action}
        details={first.details}
        onDismiss={first.onDismiss}
        dismissLabel={dismissLabel}
        index={1}
      />
      {rest.map((item, i) => (
        <NoticeLine
          key={item.id}
          tone={item.tone}
          lead={item.lead}
          text={item.details ? undefined : item.text}
          action={item.action}
          details={item.details}
          onDismiss={item.onDismiss}
          dismissLabel={dismissLabel}
          index={i + 2}
        />
      ))}
    </div>
  );
}
