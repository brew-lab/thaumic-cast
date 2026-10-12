import type { ComponentChildren, JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { useAnnouncer } from '../Announcer';
import { Artwork } from '../Artwork';
import { Badge, type BadgeTone } from '../Badge';
import type { ActionLabels } from '../Button/action';
import { Checkbox } from '../Checkbox';
import { IconButton } from '../IconButton';
import { NoticeLine } from '../NoticeLine';
import { StartLevel } from '../StartLevel';
import {
  startSettable,
  startShown,
  startWords,
  type StartLevelLevel,
  type StartLevelStrings,
} from '../StartLevel/start';
import { cx, dataAttributes, type DataAttributes } from '../utils/cx';
import { VolumeLine, type VolumeLineStrings } from './VolumeLine';
import styles from './RoomRow.module.css';

/** A Badge on a row: a status word, never colour alone. */
export interface RoomBadge {
  /** The tone: casting, neutral, warning, danger or busy. */
  tone: BadgeTone;
  /** The word: "In use", "No answer", "May cut out", "Joining…". */
  label: string;
}

/** A room as a row shows it. */
export interface RoomRef {
  /** The room's id (its player UUID). */
  id: string;
  /** The room's name. */
  name: string;
}

/** Props for RoomRow `pick`: choosing rooms before Cast (or in the add list). */
export interface RoomRowPickProps extends DataAttributes {
  /** pick: the row is one checkbox; its label holds the room's lines. */
  mode: 'pick';
  /** The room. */
  room: RoomRef;
  /** "Grouped with Patio": the room is in a Sonos group now. */
  grouped?: string;
  /** In use, Casting, Casting from elsewhere, or No answer. */
  badge?: RoomBadge;
  /** The room does not answer: the row is disabled and shows no level. */
  unavailable?: boolean;
  /** What is known about the room's level (P-start). */
  level: StartLevelLevel;
  /** "Start no louder than", or null when it is off. */
  limit: number | null;
  /** Chosen. */
  checked: boolean;
  /** Called with the new choice. */
  onCheckedChange: (checked: boolean) => void;
  /** The StartLine is open (a chosen room only). */
  startOpen?: boolean;
  /** Opens or shuts the StartLine. */
  onStartOpenChange?: (open: boolean) => void;
  /** Sets the start level by hand, for this cast only. */
  onStartSet?: (level: number) => void;
  /** The start level's words. */
  strings: StartLevelStrings;
  /** Its place in the list (1 for the first), for the entrance stagger on the floors. */
  index?: number;
}

/** A failure on a cast row: did not join, or still playing after Remove. */
export interface RoomFailure {
  /** The row line's lead: "Bedroom did not join", "Study is still playing". */
  lead: string;
  /** Try again: busy while it runs. */
  retry: {
    /** "Try again". */
    label: string;
    /** Runs it again. */
    onAction: () => Promise<unknown>;
    /** Its busy and failed words. */
    labels?: ActionLabels;
  };
  /** Dismisses the line (the Badge stays). */
  onDismiss: () => void;
}

/** The words a cast row needs, beyond its volume line's. */
export interface RoomRowCastStrings extends VolumeLineStrings {
  /** `remove_speaker`: "Remove {{name}}". */
  remove: (name: string) => string;
  /** `room_joining`: "{{name}} is joining…", the row's name while joining, said once. */
  joining: (name: string) => string;
  /** `dismiss`: the row line's X. */
  dismiss: string;
}

/** Props for RoomRow `cast`: a room in a running cast. */
export interface RoomRowCastProps {
  /** cast: name and Badge; mute, Slider, value and Remove. */
  mode: 'cast';
  /** The room. */
  room: RoomRef;
  /** Its level, or undefined while not known. */
  volume?: number;
  /** Muted. */
  muted: boolean;
  /** A fixed output. */
  fixed?: boolean;
  /** Sets the level. */
  onVolume: (volume: number) => void;
  /** Mutes or unmutes. */
  onMute: (muted: boolean) => void;
  /** Shows Remove: false for the last room, which Stop ends. */
  removable: boolean;
  /** Removes the room from the cast. */
  onRemove?: () => void;
  /**
   * Joining: the row is inert at the level it joins at ("…" while that is not known), its
   * mute and slider drawn disabled and no Remove, until the room plays. Pair it with a busy
   * Badge ("Joining…").
   */
  joining?: { level?: number };
  /** A condition (May cut out), joining, or a failure (Did not join, Still playing). */
  badge?: RoomBadge;
  /** A failure: a danger row line with Try again and X, after the row. */
  failure?: RoomFailure;
  /** The words. */
  strings: RoomRowCastStrings;
  /** Its place in the list (1 for the first), for the entrance stagger on the floors. */
  index?: number;
}

/** Props for RoomRow `list`: read only (onboarding, the desktop). */
export interface RoomRowListProps {
  /** list: a disc, the name, a sub line and a Badge; nothing is focusable. */
  mode: 'list';
  /** The room. */
  room: RoomRef;
  /** A sub line under the name. */
  sub?: string;
  /** A Badge at the end. */
  badge?: RoomBadge;
}

/** Props for {@link RoomRow}. */
export type RoomRowProps = RoomRowPickProps | RoomRowCastProps | RoomRowListProps;

/**
 * One row per room (DESIGN.md M-roomrow). A home theatre, a stereo pair or a zone is one
 * room. Three modes and no others: `pick` (a checkbox row, with StartLevel outside its label
 * once chosen), `cast` (a room in a running cast: its volume line, Remove, and a row line on
 * failure) and `list` (read only, inside a {@link RoomList}). A chosen row never reshapes or
 * tints; a `pick` row takes the bevel on focus and press, as its Checkbox does.
 * @param props - Component props: `mode` picks the kind
 * @returns The row
 */
export function RoomRow(props: RoomRowProps): JSX.Element {
  if (props.mode === 'pick') return <PickRow {...props} />;
  if (props.mode === 'cast') return <CastRow {...props} />;
  return <ListRow {...props} />;
}

/**
 * A row in the picker: the Checkbox atom, whose label is the room's lines.
 * @param props - The pick props
 * @returns The row
 */
function PickRow(props: RoomRowPickProps): JSX.Element {
  const {
    room,
    grouped,
    badge,
    unavailable = false,
    level,
    limit,
    checked,
    onCheckedChange,
    startOpen = false,
    onStartOpenChange,
    onStartSet,
    strings,
    index,
    ...rest
  } = props;
  const shown = startShown(level, limit);
  const words = startWords(shown, room.name, strings);
  // A chosen room takes the LevelButton, "…" included, so its start can be set by hand.
  const levelControl = checked && !unavailable && startSettable(shown);
  const sub = !unavailable ? words.sub : undefined;
  const hasSub = Boolean(grouped || badge || sub);
  return (
    <div
      class={cx(styles.pick, hasSub && styles.withSub)}
      data-room={room.id}
      style={index === undefined ? undefined : { '--i': index }}
    >
      <Checkbox
        checked={checked}
        onChange={onCheckedChange}
        disabled={unavailable}
        {...dataAttributes(rest)}
        label={
          <span class={styles.label}>
            <span class={styles.lines}>
              <span class={styles.name}>{room.name}</span>
              {hasSub && (
                <span class={styles.sub}>
                  {grouped && <span class={styles.phrase}>{grouped}</span>}
                  {badge && <Badge tone={badge.tone} label={badge.label} />}
                  {sub && <span class={cx(styles.phrase, 'num')}>{sub}</span>}
                </span>
              )}
              {!unavailable && !levelControl && <span class="visually-hidden">{words.spoken}</span>}
            </span>
            {!unavailable && !levelControl && (
              <span class={cx(styles.trail, 'num')} aria-hidden="true">
                {words.text}
              </span>
            )}
          </span>
        }
      />
      {levelControl && (
        <StartLevel
          roomName={room.name}
          {...level}
          limit={limit}
          open={startOpen}
          onOpenChange={(open) => onStartOpenChange?.(open)}
          onSet={(value) => onStartSet?.(value)}
          strings={strings}
        />
      )}
    </div>
  );
}

/**
 * A room in a running cast: its name and Badge, then its volume line and Remove.
 * @param props - The cast props
 * @returns The row, and its row line on failure
 */
function CastRow(props: RoomRowCastProps): JSX.Element {
  const {
    room,
    volume,
    muted,
    fixed,
    onVolume,
    onMute,
    removable,
    onRemove,
    joining,
    badge,
    failure,
    strings,
    index,
  } = props;
  const { say } = useAnnouncer();
  const isJoining = joining !== undefined;
  const name = isJoining ? strings.joining(room.name) : room.name;
  useEffect(() => {
    if (isJoining) say(strings.joining(room.name));
  }, [isJoining, room.name]);

  return (
    <div
      class={styles.cast}
      data-room={room.id}
      style={index === undefined ? undefined : { '--i': index }}
    >
      <div
        class={styles.castRow}
        role="group"
        aria-label={name}
        aria-busy={isJoining ? 'true' : undefined}
      >
        <div class={styles.head}>
          <span class={styles.castName}>{room.name}</span>
          {badge && <Badge tone={badge.tone} label={badge.label} />}
        </div>
        <div class={styles.body} inert={isJoining || undefined}>
          <VolumeLine
            name={room.name}
            volume={isJoining ? joining.level : volume}
            muted={muted}
            fixed={fixed}
            onVolume={onVolume}
            onMute={onMute}
            disabled={isJoining}
            strings={strings}
            // The Remove slot is always there, so every row's Slider lines up.
            slot
            trailing={
              removable && onRemove && !isJoining ? (
                <IconButton glyph="stop" label={strings.remove(room.name)} onPress={onRemove} />
              ) : undefined
            }
          />
        </div>
      </div>
      {failure && (
        <NoticeLine
          tone="danger"
          lead={failure.lead}
          action={{
            label: failure.retry.label,
            onAction: failure.retry.onAction,
            labels: failure.retry.labels,
          }}
          onDismiss={failure.onDismiss}
          dismissLabel={strings.dismiss}
          urgent
        />
      )}
    </div>
  );
}

/**
 * A read-only row: a disc, the name over a sub line, and a Badge.
 * @param props - The list props
 * @returns The list item
 */
function ListRow(props: RoomRowListProps): JSX.Element {
  const { room, sub, badge } = props;
  return (
    <li class={styles.list} data-room={room.id}>
      <Artwork kind="disc" size="md" glyph="speaker" />
      <span class={styles.listText}>
        <span class={styles.listName}>{room.name}</span>
        {sub && <span class={styles.listSub}>{sub}</span>}
      </span>
      {badge && <Badge tone={badge.tone} label={badge.label} />}
    </li>
  );
}

/** Props for {@link RoomList}. */
export interface RoomListProps {
  /** The list's accessible name: "Rooms that answered". */
  label: string;
  /** The `list` rows. */
  children: ComponentChildren;
}

/**
 * The list that holds RoomRow `list` rows: a labelled `<ul>` with the list reset and the
 * rows' gap (each row draws its own rule).
 * @param props - Component props
 * @param props.label - The list's accessible name
 * @param props.children - The rows
 * @returns The list
 */
export function RoomList({ label, children }: RoomListProps): JSX.Element {
  return (
    <ul class={styles.rooms} aria-label={label}>
      {children}
    </ul>
  );
}
