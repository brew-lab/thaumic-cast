import type { ComponentChildren, JSX } from 'preact';
import { useId } from 'preact/hooks';
import { Badge, type BadgeTone } from '../Badge';
import { Card } from '../Card';
import { Meter, type MeterProps } from '../Meter';
import styles from './RoomCard.module.css';

/** Props for {@link RoomCard}. */
export interface RoomCardProps {
  /** The room: "Kitchen". */
  name: string;
  /** The line under it: "Sonos One · 192.168.1.31", or "Grouped with Dining Room". */
  sub?: string;
  /** What the room is doing: Casting, In use, Paused, Not playing, Loading (busy). */
  badge?: { tone: BadgeTone; label: string } | null;
  /** What it plays, a read-only MediaHeader, once the desktop knows (§12). */
  media?: ComponentChildren;
  /** The cast's URL control (a CopyField "Copy URL"), while it casts. */
  copy?: ComponentChildren;
  /** Its reserve, with Show diagnostics on and a reading to show. */
  meter?: MeterProps | null;
  /** The name's heading level. Defaults to 2. */
  headingLevel?: 2 | 3;
}

/**
 * One room on the desktop's Rooms view (DESIGN.md C-roomcard), read-only: no Stop and no
 * volume. A Card named by the room. The head is the name then the Badge on a wrapping line:
 * the name wraps but is never cut off, and the Badge sits after it, dropping under it only
 * when the name needs the room. The sub line (the model and address,
 * or who the room is grouped with) has a full-width line of its own, so the name and the
 * model never share a line with the Badge. Then what it plays, the cast's URL control and the
 * reserve Meter, each only when there is one.
 * @param props - Component props
 * @param props.name - The room
 * @param props.sub - The line under it
 * @param props.badge - What the room is doing
 * @param props.media - What it plays
 * @param props.copy - The cast's URL control
 * @param props.meter - Its reserve
 * @param props.headingLevel - The name's heading level
 * @returns The card
 */
export function RoomCard({
  name,
  sub,
  badge,
  media,
  copy,
  meter,
  headingLevel = 2,
}: RoomCardProps): JSX.Element {
  const headingId = useId();
  const Heading = `h${headingLevel}` as const;
  return (
    <Card labelledBy={headingId}>
      <div class={styles.head} data-room-card="">
        <div class={styles.title}>
          <Heading id={headingId} class={styles.name}>
            {name}
          </Heading>
          {badge && <Badge tone={badge.tone} label={badge.label} />}
        </div>
        {sub && <p class={styles.sub}>{sub}</p>}
      </div>
      {media}
      {copy}
      {meter && <Meter {...meter} />}
    </Card>
  );
}
