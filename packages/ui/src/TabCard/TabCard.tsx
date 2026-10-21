import type { JSX } from 'preact';
import { useId } from 'preact/hooks';
import { Card } from '../Card';
import { MediaHeader, type MediaHeaderProps } from '../MediaHeader';
import { RoomPicker, type RoomPickerProps } from '../RoomPicker';
import styles from './TabCard.module.css';

/** Props for {@link TabCard}. */
export interface TabCardProps {
  /**
   * What this tab (or, with browser-wide capture, the whole browser) plays. The TabCard
   * draws it large, with its title as the card's heading, and no transport, disclosure or
   * live dot: nothing goes out to speakers until it casts (§11 call 93).
   */
  media: Omit<
    MediaHeaderProps,
    'size' | 'level' | 'titleId' | 'disclosure' | 'transport' | 'band' | 'playing'
  >;
  /** Where it can go. */
  picker: RoomPickerProps;
  /** The card's id. */
  id?: string;
}

/**
 * This tab, when it is not casting (DESIGN.md C-tabcard): a Card (a `<section>` named by the
 * title, its heading an `h2` that P-stop can move focus to) holding the MediaHeader at `lg`
 * and the RoomPicker, with no live dot. The CastBar in the StickyActionBar acts on it. While this tab casts,
 * its CastTile is shown open instead.
 * @param props - Component props
 * @param props.media - What the tab plays
 * @param props.picker - Where it can go
 * @param props.id - The card's id
 * @returns The card
 */
export function TabCard({ media, picker, id }: TabCardProps): JSX.Element {
  const titleId = useId();
  return (
    <Card flush id={id} labelledBy={titleId}>
      <div class={styles.tab}>
        <div class={styles.head}>
          <MediaHeader {...media} playing={false} size="lg" level={2} titleId={titleId} />
        </div>
        <RoomPicker {...picker} />
      </div>
    </Card>
  );
}
