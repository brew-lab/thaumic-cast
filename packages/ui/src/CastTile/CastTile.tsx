import type { JSX } from 'preact';
import { useId, useLayoutEffect, useRef } from 'preact/hooks';
import { Button } from '../Button';
import { Card } from '../Card';
import { GroupVolume, type GroupVolumeProps } from '../GroupVolume';
import { MediaHeader, type MediaHeaderProps } from '../MediaHeader';
import { NoticeLine, type NoticeLineProps } from '../NoticeLine';
import { NoticeSlot, type NoticeSlotProps } from '../NoticeSlot';
import { VideoSync, type VideoSyncProps } from '../VideoSync';
import styles from './CastTile.module.css';

/** Props for {@link CastTile}. */
export interface CastTileProps {
  /**
   * What the cast plays: the subtitle is the rooms joined by " + ". Its band, transport and
   * Go to tab show only while the tile is open.
   */
  media: Omit<MediaHeaderProps, 'size' | 'level' | 'titleId' | 'disclosure' | 'trailing'>;
  /** Open in place: the band, GroupVolume, the slot, the notes and VideoSync. */
  open: boolean;
  /**
   * Opens or shuts it. Without it the tile has no chevron and cannot shut (a single cast).
   */
  onOpenChange?: (open: boolean) => void;
  /** Stop: tonal danger, the square and "Stop", named "Stop casting {{title}}". No Undo. */
  stop: {
    /** "Stop". */
    label: string;
    /** "Stop casting {{title}}". */
    name: string;
    /** Stops the cast; the square fades to the Clacks while it runs, the words held. */
    onStop: () => Promise<unknown>;
  };
  /** The cast's volume (compact: the master, or the only room's line). */
  volume: Omit<GroupVolumeProps, 'compact'>;
  /** What is wrong with the cast, already placed and ordered (P-notices). */
  notices: Omit<NoticeSlotProps, 'compact' | 'onOpenTile'>;
  /** Tile notes after the slot (open only): "Patio left this cast" + Details + X. */
  notes?: (NoticeLineProps & { id: string })[];
  /** Video sync, when the cast has it (open only). */
  videoSync?: VideoSyncProps;
  /** The tile's id. */
  id?: string;
}

/**
 * One running cast (DESIGN.md C-casttile). Compact: the MediaHeader (a disclosure, the
 * artwork, the title and the rooms) and Stop, one volume line, and the slot's one line, which
 * opens the tile. Open, in place: the artwork-seeded band with the transport and Go to tab,
 * then GroupVolume, the NoticeSlot, tile notes and VideoSync. The head row is the same
 * element in both forms, in the same place, so focus and Stop never move; opening and shutting
 * are instant. A `<section>` named by the title; the
 * disclosure controls the body. Tiles are independent, and nothing opens unless pressed.
 * @param props - Component props
 * @param props.media - What the cast plays
 * @param props.open - Open in place
 * @param props.onOpenChange - Opens or shuts it; absent, no chevron
 * @param props.stop - Stop
 * @param props.volume - The cast's volume
 * @param props.notices - What is wrong with it
 * @param props.notes - Tile notes
 * @param props.videoSync - Video sync
 * @param props.id - The tile's id
 * @returns The tile
 */
export function CastTile({
  media,
  open,
  onOpenChange,
  stop,
  volume,
  notices,
  notes = [],
  videoSync,
  id,
}: CastTileProps): JSX.Element {
  const ids = useId();
  const titleId = `${ids}-title`;
  const bodyId = `${ids}-body`;
  const tileRef = useRef<HTMLDivElement>(null);
  const shownOpen = useRef(open);
  // A change of form is instant: what it mounts makes no entrance (§11 call 83).
  useLayoutEffect(() => {
    const tile = tileRef.current;
    if (!tile || shownOpen.current === open) return;
    shownOpen.current = open;
    tile.setAttribute('data-instant', '');
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => tile.removeAttribute('data-instant'));
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);
  return (
    <Card flush id={id} labelledBy={titleId}>
      <div ref={tileRef} class={styles.tile} data-open={open ? '' : undefined}>
        <div class={styles.head}>
          <MediaHeader
            {...media}
            size="md"
            titleId={titleId}
            disclosure={
              onOpenChange && {
                expanded: open,
                controls: bodyId,
                onToggle: () => onOpenChange(!open),
              }
            }
            band={open ? media.band : undefined}
            transport={open ? media.transport : undefined}
            onGoToTab={open ? media.onGoToTab : undefined}
            trailing={
              <Button kind="tonal" danger icon="stop" aria-label={stop.name} onAction={stop.onStop}>
                {stop.label}
              </Button>
            }
          />
        </div>
        <div id={bodyId} class={styles.body}>
          <GroupVolume {...volume} compact={!open} />
          <NoticeSlot
            {...notices}
            compact={!open}
            onOpenTile={onOpenChange && (() => onOpenChange(true))}
          />
          {open && notes.map(({ id: noteId, ...note }) => <NoticeLine key={noteId} {...note} />)}
          {open && videoSync && <VideoSync {...videoSync} />}
        </div>
      </div>
    </Card>
  );
}
