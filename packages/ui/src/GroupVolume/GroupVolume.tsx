import type { JSX } from 'preact';
import { useId, useLayoutEffect, useRef } from 'preact/hooks';
import { Button } from '../Button';
import { parseTime } from '../Button/morph';
import { Disclosure } from '../Disclosure';
import { Divider } from '../Divider';
import {
  RoomRow,
  VolumeLine,
  type RoomRowCastProps,
  type RoomRowCastStrings,
  type RoomRowPickProps,
} from '../RoomRow';
import type { StartLevelStrings } from '../StartLevel/start';
import { allMuted, meanVolume, volumeSummary, type SummaryStrings } from './summary';
import styles from './GroupVolume.module.css';

/** One room of the cast, as a RoomRow `cast` takes it; GroupVolume decides Remove. */
export type GroupVolumeRoom = Omit<RoomRowCastProps, 'mode' | 'strings' | 'removable' | 'index'>;

/** One room of the add list, as a RoomRow `pick` takes it. */
export type GroupVolumeAddRoom = Omit<RoomRowPickProps, 'mode' | 'strings' | 'index'>;

/** The words GroupVolume needs, from the app's locale. */
export interface GroupVolumeStrings extends RoomRowCastStrings, SummaryStrings {
  /** `rooms_count_one` / `_other`: "1 room" / "{{count}} rooms", the fold's label. */
  roomsCount: (count: number) => string;
  /** `add_room`: "Add a room". */
  addRoom: string;
  /** `add_to_cast`: "Add to this cast", the add list's legend. */
  addLegend: string;
  /** The add list's start levels. */
  start: StartLevelStrings;
}

/** Props for {@link GroupVolume}. */
export interface GroupVolumeProps {
  /** The cast's rooms, in order. */
  rooms: GroupVolumeRoom[];
  /**
   * The master, from two rooms: named by the joined names ("Kitchen + TV Room"). Its level
   * defaults to the mean of the known levels, and it reads muted only when every room is.
   */
  master?: {
    /** The joined names. */
    name: string;
    /** Its level; the mean of the rooms' by default. */
    volume?: number;
    /** Muted; every room muted by default. */
    muted?: boolean;
    /** Moves every room by the same ratio. */
    onVolume: (volume: number) => void;
    /** Mutes or unmutes every room. */
    onMute: (muted: boolean) => void;
  };
  /** The rooms fold is open (remembered for the popup session; shut for a new cast). */
  expanded: boolean;
  /** Opens or shuts the rooms fold. */
  onExpandedChange: (open: boolean) => void;
  /** The fold's summary; by default every room's level, conditions first. */
  summary?: string;
  /** The compact tile: one volume line (the master, or the only room's), nothing else. */
  compact?: boolean;
  /** "Add a room" and its add list, committed from the CastBar's add mode. */
  add?: {
    /** The add list is open. */
    open: boolean;
    /** Opens or shuts it. */
    onOpenChange: (open: boolean) => void;
    /** The rooms that can be added: none already in the cast, no sets. */
    rooms: GroupVolumeAddRoom[];
  };
  /** The words. */
  strings: GroupVolumeStrings;
}

/**
 * The volume of one cast (DESIGN.md M-groupvol). One room: its row and "Add a room". Two or
 * more: a master (showing the mean), then the "{{count}} rooms" fold whose summary lists the
 * levels, holding the rows and "Add a room" last, which opens the add list (a fieldset of
 * RoomRow `pick`), scrolled into view above the bar it brings in; shutting it gives focus back
 * to "Add a room". The last room has no Remove; Stop ends the cast.
 * @param props - Component props
 * @param props.rooms - The cast's rooms
 * @param props.master - The master, from two rooms
 * @param props.expanded - The fold is open
 * @param props.onExpandedChange - Opens or shuts the fold
 * @param props.summary - The fold's summary
 * @param props.compact - One volume line only
 * @param props.add - Add a room and its list
 * @param props.strings - The words
 * @returns The group volume
 */
export function GroupVolume({
  rooms,
  master,
  expanded,
  onExpandedChange,
  summary,
  compact = false,
  add,
  strings,
}: GroupVolumeProps): JSX.Element {
  const addId = useId();
  const addRef = useRef<HTMLDivElement>(null);
  const addOpen = add?.open ?? false;
  const wasOpen = useRef(addOpen);
  // Opening the add list brings in the CastBar's add mode, which can cover "Add a room": once
  // the bar is in, the trigger and the list are scrolled into view above it (the scroller's
  // end padding follows the bar). Shutting it (Cancel or Add in the bar, which go with it)
  // gives focus back to "Add a room" (WCAG 2.4.3).
  useLayoutEffect(() => {
    if (wasOpen.current === addOpen) return;
    wasOpen.current = addOpen;
    const part = addRef.current;
    const trigger = part?.querySelector<HTMLElement>('button');
    if (!part || !trigger) return;
    if (!addOpen) {
      const active = part.ownerDocument.activeElement;
      if (!active || active === part.ownerDocument.body) trigger.focus();
      return;
    }
    const reveal = (behavior: ScrollBehavior): void => {
      part.scrollIntoView({ block: 'nearest', behavior });
      trigger.scrollIntoView({ block: 'nearest', behavior });
    };
    // Once the bar is in, and again, gently, once a fold round the list has finished growing
    // (until then the page cannot scroll that far). --dur-change is 0 under reduced motion.
    const settle = parseTime(getComputedStyle(part).getPropertyValue('--dur-change'));
    const frame = requestAnimationFrame(() => reveal('auto'));
    const timer = setTimeout(() => reveal(settle > 0 ? 'smooth' : 'auto'), settle + 50);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [addOpen]);
  const summaryRooms = rooms.map((r) => ({
    name: r.room.name,
    volume: r.volume,
    muted: r.muted,
    joining: r.joining,
    condition:
      r.badge && (r.badge.tone === 'warning' || r.badge.tone === 'danger')
        ? r.badge.label
        : undefined,
  }));
  const playing = rooms.filter((r) => !r.joining).length;
  const several = rooms.length > 1 && master;

  // Open, the master keeps the rows' empty Remove slot, so the card has one volume column;
  // the compact tile's line has nothing after it.
  const masterLine = (slot: boolean): JSX.Element | undefined =>
    master && (
      <VolumeLine
        name={master.name}
        volume={master.volume ?? meanVolume(summaryRooms)}
        muted={master.muted ?? allMuted(summaryRooms)}
        onVolume={master.onVolume}
        onMute={master.onMute}
        slot={slot}
        strings={strings}
      />
    );

  const row = (r: GroupVolumeRoom, i: number): JSX.Element => (
    <RoomRow
      key={r.room.id}
      mode="cast"
      {...r}
      removable={playing > 1 && !r.joining}
      strings={strings}
      index={i + 1}
    />
  );

  if (compact) {
    const only = rooms[0];
    return (
      <div class={styles.group}>
        {several
          ? masterLine(false)
          : only && (
              <VolumeLine
                name={only.room.name}
                volume={only.volume}
                muted={only.muted}
                fixed={only.fixed}
                onVolume={only.onVolume}
                onMute={only.onMute}
                strings={strings}
              />
            )}
      </div>
    );
  }

  const addPart = add && (
    <div ref={addRef} class={styles.add}>
      <Button
        kind="quiet"
        size="md"
        icon="plus"
        flush
        expanded={add.open}
        aria-controls={add.open ? addId : undefined}
        onClick={() => add.onOpenChange(!add.open)}
      >
        {strings.addRoom}
      </Button>
      {add.open && (
        <fieldset id={addId} class={styles.addList}>
          <legend class={styles.legend}>{strings.addLegend}</legend>
          {add.rooms.map((r, i) => (
            <RoomRow key={r.room.id} mode="pick" {...r} strings={strings.start} index={i + 1} />
          ))}
        </fieldset>
      )}
    </div>
  );

  if (!several) {
    return (
      <div class={styles.group}>
        {rooms.map(row)}
        {addPart}
      </div>
    );
  }

  return (
    <div class={styles.group}>
      {masterLine(true)}
      <Divider />
      <Disclosure
        size="md"
        label={strings.roomsCount(rooms.length)}
        summary={summary ?? volumeSummary(summaryRooms, strings)}
        open={expanded}
        onOpenChange={onExpandedChange}
      >
        <div class={styles.rows}>{rooms.map(row)}</div>
        {addPart && <Divider />}
        {addPart}
      </Disclosure>
    </div>
  );
}
