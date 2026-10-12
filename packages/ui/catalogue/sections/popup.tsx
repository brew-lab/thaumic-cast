import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { VideoSyncPhase } from '@thaumic-cast/protocol';
import { Button } from '../../src/Button';
import { GroupVolume, type GroupVolumeProps, type GroupVolumeRoom } from '../../src/GroupVolume';
import { VideoSync } from '../../src/VideoSync';
import { RoomPicker, type PickerSet, type RoomPickerProps } from '../../src/RoomPicker';
import { TabCard } from '../../src/TabCard';
import { PopupShell } from '../../src/PopupShell';
import { StickyActionBar } from '../../src/StickyActionBar';
import { Notice } from '../../src/Notice';
import { NoticeLine } from '../../src/NoticeLine';
import { SectionHeader } from '../../src/SectionHeader';
import { Toast } from '../../src/Toast';
import { CastTile, type CastTileProps } from '../../src/CastTile';
import { CastBar, type CastBarProps } from '../../src/CastBar';
import { NoticeSlot, type NoticeSlotItem } from '../../src/NoticeSlot';
import { PopupHeader, type PopupConnection } from '../../src/PopupHeader';
import { BrandBlock } from '../../src/BrandBlock';
import { IconButton } from '../../src/IconButton';
import { StatusDot } from '../../src/StatusDot';
import { MediaHeader, artBand, type MediaHeaderProps } from '../../src/MediaHeader';
import { RoomRow, type RoomRowCastProps, type RoomRowPickProps } from '../../src/RoomRow';
import { StartLevel } from '../../src/StartLevel';
import type { StartLevelLevel } from '../../src/StartLevel/start';
import { Frames } from './containers';
import { CAST_ROW, GROUP, MEDIA, PICKER, START, SYNC, SYNC_EXTRA } from './popup-strings';

const noop = (): void => {};
const never = (): Promise<void> => new Promise(() => {});

/**
 * Presses the first button inside it once, after mounting, to draw a busy state.
 * @param props - Component props
 * @param props.children - The specimen
 * @returns The specimen
 */
function PressedOnMount({ children }: { children: ComponentChildren }): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('button')?.click();
  }, []);
  return <div ref={box}>{children}</div>;
}

/**
 * A popup column: a card surface as wide as the popup's rows (325 px), so a specimen is
 * drawn at its true size. The label says what it shows.
 * @param props - Component props
 * @param props.label - What the column shows
 * @param props.children - The specimen
 * @returns The column
 */
export function PopupColumn({
  label,
  children,
}: {
  label: string;
  children: ComponentChildren;
}): JSX.Element {
  return (
    <div class="popup-specimen">
      <p class="label">{label}</p>
      <div class="popup-card">{children}</div>
    </div>
  );
}

/* -------------------------------------------------------------- StartLevel */

/**
 * One StartLevel inside a stand-in row, holding its own open state and level.
 * @param props - Component props
 * @param props.name - The room
 * @param props.level - What is known about its level
 * @param props.limit - The start limit
 * @param props.open - Open at first
 * @param props.force - A forced grammar state for the LevelButton
 * @returns The start level
 */
function Start({
  name,
  level,
  limit = 30,
  open: startOpen = false,
  force,
}: {
  name: string;
  level: StartLevelLevel;
  limit?: number | null;
  open?: boolean;
  force?: 'hover' | 'focus' | 'press';
}): JSX.Element {
  const [open, setOpen] = useState(startOpen);
  const [set, setSet] = useState(level.set);
  return (
    <div class="start-row">
      <span class="start-row-name">{name}</span>
      <StartLevel
        roomName={name}
        {...level}
        set={set}
        limit={limit}
        open={open}
        onOpenChange={setOpen}
        onSet={setSet}
        strings={START}
        data-force={force}
      />
    </div>
  );
}

/**
 * StartLevel: every row of annex 2 §4's table, the LevelButton's grammar and the StartLine
 * open.
 * @returns The specimen
 */
export function StartLevelSpecimen(): JSX.Element {
  return (
    <div class="popup-specimens">
      <PopupColumn label="shut: the table's rows">
        <Start name="Study" level={{ now: 18 }} />
        <Start name="Living Room" level={{ now: 72 }} />
        <Start name="Kitchen" level={{ now: 41, set: 12 }} />
        <Start name="Study" level={{ now: 30, set: 45 }} />
        <Start name="Bedroom" level={{}} />
        <Start name="Port" level={{ fixed: true }} />
        <Start name="Study" level={{ now: 52 }} limit={null} />
      </PopupColumn>
      <PopupColumn label="open: capped, set lower, set higher, at the level">
        <Start name="Living Room" level={{ now: 72 }} open />
        <Start name="Kitchen" level={{ now: 41, set: 12 }} open />
        <Start name="Study" level={{ now: 30, set: 45 }} open />
        <Start name="Study" level={{ now: 18 }} open />
      </PopupColumn>
      <PopupColumn label="hover, focus-visible, press">
        <Start name="Study" level={{ now: 18 }} force="hover" />
        <Start name="Study" level={{ now: 18 }} force="focus" />
        <Start name="Study" level={{ now: 18 }} force="press" />
      </PopupColumn>
    </div>
  );
}

/* ------------------------------------------------------------ RoomRow pick */

type PickSpec = Omit<
  RoomRowPickProps,
  'mode' | 'strings' | 'checked' | 'onCheckedChange' | 'limit'
> & {
  checked?: boolean;
  limit?: number | null;
  startOpen?: boolean;
};

/**
 * A pick row that holds its own choice, start level and StartLine.
 * @param props - The row, as RoomRow takes it, with a starting choice
 * @returns The row
 */
export function Pick(props: PickSpec): JSX.Element {
  const [checked, setChecked] = useState(props.checked ?? false);
  const [open, setOpen] = useState(props.startOpen ?? false);
  const [set, setSet] = useState(props.level.set);
  return (
    <RoomRow
      {...props}
      mode="pick"
      limit={props.limit === undefined ? 30 : props.limit}
      level={{ ...props.level, set }}
      checked={checked}
      onCheckedChange={setChecked}
      startOpen={open}
      onStartOpenChange={setOpen}
      onStartSet={setSet}
      strings={START}
    />
  );
}

/**
 * A cast row with live volume and mute.
 * @param props - The row, as RoomRow takes it
 * @returns The row
 */
export function Cast(
  props: Omit<RoomRowCastProps, 'mode' | 'strings' | 'onVolume' | 'onMute' | 'muted'> & {
    muted?: boolean;
  },
): JSX.Element {
  const [volume, setVolume] = useState(props.volume);
  const [muted, setMuted] = useState(props.muted ?? false);
  return (
    <RoomRow
      {...props}
      mode="cast"
      volume={volume}
      muted={muted}
      onVolume={setVolume}
      onMute={setMuted}
      strings={CAST_ROW}
    />
  );
}

const room = (name: string): { id: string; name: string } => ({
  id: `RINCON_${name.replace(/\W/g, '').toUpperCase()}`,
  name,
});

/**
 * RoomRow pick: rest, chosen (with its StartLevel), the grammar, unavailable, grouped,
 * every status Badge, unknown and fixed levels, a long name, and a disabled fieldset.
 * @returns The specimen
 */
export function RoomRowPickSpecimen(): JSX.Element {
  return (
    <div class="popup-specimens">
      <PopupColumn label="rest, chosen, chosen with the StartLine open">
        <div class="pick-list">
          <Pick room={room('Study')} level={{ now: 18 }} />
          <Pick room={room('Living Room')} level={{ now: 72 }} checked />
          <Pick room={room('Kitchen')} level={{ now: 41 }} checked startOpen />
          <Pick room={room('Bedroom')} level={{ now: 72 }} />
        </div>
      </PopupColumn>
      <PopupColumn label="hover, focus-visible, press: the layer on the row, no shape">
        <div class="pick-list">
          <Pick room={room('Study')} level={{ now: 18 }} data-force="hover" />
          <Pick room={room('Study')} level={{ now: 18 }} data-force="focus" />
          <Pick room={room('Study')} level={{ now: 18 }} checked data-force="press" />
        </div>
      </PopupColumn>
      <PopupColumn label="grouped, status, unavailable, unknown, fixed, a long name">
        <div class="pick-list">
          <Pick room={room('Kitchen')} grouped="Grouped with Patio" level={{ now: 25 }} checked />
          <Pick
            room={room('Office')}
            badge={{ tone: 'warning', label: 'In use' }}
            level={{ now: 20 }}
            checked
          />
          <Pick
            room={room('Den')}
            badge={{ tone: 'casting', label: 'Casting' }}
            level={{ now: 15 }}
          />
          <Pick
            room={room('Landing')}
            badge={{ tone: 'neutral', label: 'Casting from elsewhere' }}
            level={{ now: 22 }}
          />
          <Pick
            room={room('Garden')}
            badge={{ tone: 'warning', label: 'No answer' }}
            unavailable
            level={{}}
          />
          <Pick room={room('Bedroom')} level={{}} checked />
          <Pick room={room('Port')} level={{ fixed: true }} checked />
          <Pick
            room={room('The Very Long Room Name Upstairs')}
            grouped="Grouped with Landing and Bathroom"
            level={{ now: 72 }}
          />
        </div>
      </PopupColumn>
      <PopupColumn label="in a disabled fieldset (not connected)">
        <fieldset class="bare-fieldset" disabled>
          <legend class="visually-hidden">Cast to</legend>
          <div class="pick-list">
            <Pick room={room('Study')} level={{ now: 18 }} checked />
            <Pick room={room('Kitchen')} level={{ now: 41 }} />
          </div>
        </fieldset>
      </PopupColumn>
    </div>
  );
}

/**
 * RoomRow cast: rest, muted, a condition, joining, did not join, still playing, the last
 * room, a fixed output and a level not known yet.
 * @returns The specimen
 */
export function RoomRowCastSpecimen(): JSX.Element {
  const retry = { label: 'Try again', onAction: never, labels: { busy: 'Trying again…' } };
  return (
    <div class="popup-specimens">
      <PopupColumn label="rest, muted, a condition, the last room">
        <div class="cast-list">
          <Cast room={room('Kitchen')} volume={30} removable onRemove={noop} />
          <Cast room={room('Living Room')} volume={46} muted removable onRemove={noop} />
          <Cast
            room={room('TV Room')}
            volume={25}
            badge={{ tone: 'warning', label: 'May cut out' }}
            removable
            onRemove={noop}
          />
          <Cast room={room('Study')} volume={18} removable={false} />
        </div>
      </PopupColumn>
      <PopupColumn label="joining, did not join, still playing">
        <div class="cast-list">
          <Cast
            room={room('Bedroom')}
            volume={30}
            joining={{ level: 30 }}
            badge={{ tone: 'busy', label: 'Joining…' }}
            removable
            onRemove={noop}
          />
          <Cast
            room={room('Bedroom')}
            volume={30}
            badge={{ tone: 'danger', label: 'Did not join' }}
            failure={{ lead: 'Bedroom did not join', retry, onDismiss: noop }}
            removable
            onRemove={noop}
          />
          <Cast
            room={room('Study')}
            volume={18}
            badge={{ tone: 'danger', label: 'Still playing' }}
            failure={{ lead: 'Study is still playing', retry, onDismiss: noop }}
            removable
            onRemove={noop}
          />
        </div>
      </PopupColumn>
      <PopupColumn label="a fixed output, a level not known yet">
        <div class="cast-list">
          <Cast room={room('Port')} volume={75} fixed removable onRemove={noop} />
          <Cast room={room('Garden')} removable onRemove={noop} />
        </div>
      </PopupColumn>
    </div>
  );
}

/**
 * RoomRow list: read only, in the popup and at desktop density.
 * @returns The specimen
 */
export function RoomRowListSpecimen(): JSX.Element {
  const rows = (
    <ul class="bare-list" aria-label="Rooms that answered">
      <RoomRow mode="list" room={room('Kitchen')} />
      <RoomRow mode="list" room={room('Living Room')} sub="Home theatre" />
      <RoomRow
        mode="list"
        room={room('Study')}
        sub="Grouped with Landing"
        badge={{ tone: 'casting', label: 'Casting' }}
      />
      <RoomRow mode="list" room={room('Garden')} badge={{ tone: 'warning', label: 'No answer' }} />
    </ul>
  );
  return (
    <div class="popup-specimens">
      <PopupColumn label="popup">{rows}</PopupColumn>
      <div class="popup-specimen" data-density="desktop">
        <p class="label">desktop density</p>
        <div class="popup-card">{rows}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- MediaHeader */

/** The R6 seeds the band was drawn with, as [lightness, chroma, hue]. */
export const SEEDS = {
  film: [0.12, 0.02, 40],
  pastel: [0.8, 0.05, 250],
  neon: [0.86, 0.3, 150],
  red: [0.5, 0.2, 27],
  video: [0.55, 0.11, 200],
} as const;

/**
 * A poster drawn in a seed's colour, as a data URI, so the catalogue needs no images.
 * @param seed - The seed
 * @returns The image URL
 */
export function poster(seed: readonly [number, number, number]): string {
  const [l, c, h] = seed;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4" fill="oklch(${l} ${c} ${h})"/><rect y="2.6" width="4" height="1.4" fill="oklch(${Math.max(0, l - 0.25)} ${c} ${h})"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const stop = (title: string): JSX.Element => (
  <Button kind="tonal" danger icon="stop" aria-label={`Stop casting ${title}`} onClick={noop}>
    Stop
  </Button>
);

const transport = {
  canPrev: true,
  canNext: true,
  canPlayPause: true,
  onPrev: noop,
  onPlayPause: noop,
  onNext: noop,
};

/**
 * A tile head with its own disclosure state.
 * @param props - The header, without its disclosure
 * @returns The header
 */
function TileHead(
  props: Omit<MediaHeaderProps, 'disclosure' | 'strings'> & { expanded?: boolean },
): JSX.Element {
  const [expanded, setExpanded] = useState(props.expanded ?? false);
  const body = useId();
  return (
    <>
      <MediaHeader
        {...props}
        strings={MEDIA}
        disclosure={{
          expanded,
          controls: body,
          onToggle: () => setExpanded(!expanded),
        }}
      />
      <div id={body} hidden={!expanded} />
    </>
  );
}

/**
 * MediaHeader: the TabCard head (tab and browser), a compact tile head in every grammar
 * state, long and paused titles, and the open tile on the artwork-seeded band for the R6
 * seeds, the red guard and a grey seed; then the read-only desktop head.
 * @returns The specimen
 */
export function MediaHeaderSpecimen(): JSX.Element {
  const long = 'A very long video title that goes on past the end of the popup row';
  return (
    <div class="popup-specimens">
      <PopupColumn label="TabCard: tab, browser, paused, no artwork">
        <MediaHeader
          kind="tab"
          size="lg"
          level={3}
          art={poster(SEEDS.video)}
          title="Video title"
          subtitle="youtube.com"
          playing
          strings={MEDIA}
        />
        <MediaHeader
          kind="browser"
          size="lg"
          title="Whole browser"
          subtitle="Browser-wide capture"
          playing
          strings={MEDIA}
        />
        <MediaHeader
          kind="tab"
          size="lg"
          title={long}
          subtitle="vimeo.com"
          playing={false}
          strings={MEDIA}
        />
      </PopupColumn>
      <PopupColumn label="compact tile: shut, open, hover, focus-visible, press, no chevron">
        <TileHead
          kind="tab"
          size="md"
          art={poster(SEEDS.pastel)}
          title="Album title"
          subtitle="Kitchen + Living Room"
          playing
          trailing={stop('Album title')}
        />
        <TileHead
          kind="tab"
          size="md"
          art={poster(SEEDS.pastel)}
          title="Album title"
          subtitle="Kitchen"
          playing
          expanded
          trailing={stop('Album title')}
        />
        <TileHead
          kind="tab"
          size="md"
          title="Album title"
          subtitle="Kitchen"
          playing
          trailing={stop('Album title')}
          data-force="hover"
        />
        <TileHead
          kind="tab"
          size="md"
          title="Album title"
          subtitle="Kitchen"
          playing
          trailing={stop('Album title')}
          data-force="focus"
        />
        <TileHead
          kind="tab"
          size="md"
          title="Album title"
          subtitle="Kitchen"
          playing={false}
          trailing={stop('Album title')}
          data-force="press"
        />
        <MediaHeader
          kind="tab"
          size="md"
          title={long}
          subtitle="Study"
          playing
          strings={MEDIA}
          trailing={stop(long)}
        />
      </PopupColumn>
      <PopupColumn label="open tile on the band: video, pastel, neon, near-black film">
        {(['video', 'pastel', 'neon', 'film'] as const).map((seed) => (
          <TileHead
            key={seed}
            kind="tab"
            size="md"
            art={poster(SEEDS[seed])}
            title={`${seed[0].toUpperCase()}${seed.slice(1)} title`}
            subtitle="Kitchen + Living Room"
            playing={seed !== 'film'}
            expanded
            band={artBand(SEEDS[seed])}
            transport={transport}
            onGoToTab={noop}
            trailing={stop('Title')}
          />
        ))}
      </PopupColumn>
      <PopupColumn label="the red guard moves Stop off the band; a grey seed is purple-grey; no session">
        <TileHead
          kind="tab"
          size="md"
          art={poster(SEEDS.red)}
          title="Film title"
          subtitle="TV Room"
          playing
          expanded
          band={artBand(SEEDS.red)}
          transport={transport}
          onGoToTab={noop}
          trailing={stop('Film title')}
        />
        <TileHead
          kind="tab"
          size="md"
          title="Video title"
          subtitle="Study"
          playing
          expanded
          band={artBand([0.55, 0.005, 0])}
          onGoToTab={noop}
          trailing={stop('Video title')}
        />
        <TileHead
          kind="browser"
          size="md"
          title="Whole browser"
          subtitle="Kitchen"
          playing
          expanded
          band={artBand([0.55, 0.005, 0])}
          trailing={stop('Whole browser')}
        />
      </PopupColumn>
      <div class="popup-specimen" data-density="desktop">
        <p class="label">desktop density: read only</p>
        <div class="popup-card">
          <MediaHeader
            kind="tab"
            size="md"
            art={poster(SEEDS.video)}
            title="Video title"
            subtitle="youtube.com"
            playing
            strings={MEDIA}
          />
          <MediaHeader
            kind="browser"
            size="md"
            title="Whole browser"
            subtitle="Browser-wide capture"
            playing={false}
            strings={MEDIA}
          />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- GroupVolume */

/**
 * Rooms for a cast, by name and level, each holding its own level and mute.
 * @param spec - Name and level pairs, with optional extras
 * @returns The rooms
 */
function castRooms(
  spec: (Partial<GroupVolumeRoom> & { name: string; volume?: number })[],
): GroupVolumeRoom[] {
  return spec.map(({ name, ...rest }) => ({
    room: room(name),
    muted: false,
    onVolume: noop,
    onMute: noop,
    onRemove: noop,
    ...rest,
  }));
}

/**
 * A GroupVolume holding its own fold, add list and levels.
 * @param props - The group, with starting state
 * @returns The group volume
 */
export function Group(
  props: Omit<GroupVolumeProps, 'expanded' | 'onExpandedChange' | 'strings' | 'add'> & {
    expanded?: boolean;
    adding?: boolean;
    addRooms?: GroupVolumeProps['add'] extends infer A
      ? A extends { rooms: infer R }
        ? R
        : never
      : never;
  },
): JSX.Element {
  const [expanded, setExpanded] = useState(props.expanded ?? false);
  const [adding, setAdding] = useState(props.adding ?? false);
  const [rooms, setRooms] = useState(props.rooms);
  const [chosen, setChosen] = useState<string[]>([]);
  const live = rooms.map((r) => ({
    ...r,
    onVolume: (v: number) =>
      setRooms((all) => all.map((x) => (x.room.id === r.room.id ? { ...x, volume: v } : x))),
    onMute: (m: boolean) =>
      setRooms((all) => all.map((x) => (x.room.id === r.room.id ? { ...x, muted: m } : x))),
  }));
  return (
    <GroupVolume
      {...props}
      rooms={live}
      master={
        props.master && {
          ...props.master,
          onVolume: (v) => setRooms((all) => all.map((x) => ({ ...x, volume: v }))),
          onMute: (m) => setRooms((all) => all.map((x) => ({ ...x, muted: m }))),
        }
      }
      expanded={expanded}
      onExpandedChange={setExpanded}
      add={
        props.addRooms && {
          open: adding,
          onOpenChange: setAdding,
          rooms: props.addRooms.map((r) => ({
            ...r,
            checked: chosen.includes(r.room.id),
            onCheckedChange: (on: boolean) =>
              setChosen((c) => (on ? [...c, r.room.id] : c.filter((id) => id !== r.room.id))),
          })),
        }
      }
      strings={GROUP}
    />
  );
}

const addable = [
  { room: room('Bedroom'), level: { now: 72 }, limit: 30, checked: false, onCheckedChange: noop },
  {
    room: room('Study'),
    grouped: 'Grouped with Landing',
    level: { now: 18 },
    limit: 30,
    checked: false,
    onCheckedChange: noop,
  },
];

const three = (): GroupVolumeRoom[] =>
  castRooms([
    { name: 'Kitchen', volume: 30 },
    { name: 'Living Room', volume: 46, muted: true },
    { name: 'TV Room', volume: 25 },
  ]);

/**
 * GroupVolume: one room, two or more with the fold shut and open, a condition, Add a room
 * open, a room joining, all muted, and the compact tile's one line.
 * @returns The specimen
 */
export function GroupVolumeSpecimen(): JSX.Element {
  const master = { name: 'Kitchen + Living Room + TV Room', onVolume: noop, onMute: noop };
  return (
    <div class="popup-specimens">
      <PopupColumn label="one room: its row and Add a room">
        <div class="cast-list">
          <Group rooms={castRooms([{ name: 'Kitchen', volume: 30 }])} addRooms={addable} />
        </div>
      </PopupColumn>
      <PopupColumn label="three rooms: master (the mean) and the fold shut; a condition">
        <div class="cast-list">
          <Group rooms={three()} master={master} addRooms={addable} />
          <Group
            rooms={castRooms([
              { name: 'Kitchen', volume: 30, badge: { tone: 'warning', label: 'May cut out' } },
              { name: 'Patio', volume: 46 },
            ])}
            master={{ ...master, name: 'Kitchen + Patio' }}
            addRooms={addable}
          />
        </div>
      </PopupColumn>
      <PopupColumn label="fold open, Add a room open">
        <div class="cast-list">
          <Group rooms={three()} master={master} expanded adding addRooms={addable} />
        </div>
      </PopupColumn>
      <PopupColumn label="after Add: a room joining; every room muted">
        <div class="cast-list">
          <Group
            rooms={castRooms([
              { name: 'Kitchen', volume: 30 },
              { name: 'TV Room', volume: 25 },
              {
                name: 'Bedroom',
                volume: 30,
                joining: { level: 30 },
                badge: { tone: 'busy', label: 'Joining…' },
              },
            ])}
            master={{ ...master, name: 'Kitchen + TV Room' }}
            expanded
            addRooms={addable}
          />
          <Group
            rooms={castRooms([
              { name: 'Kitchen', volume: 30, muted: true },
              { name: 'Patio', volume: 20, muted: true },
            ])}
            master={{ ...master, name: 'Kitchen + Patio' }}
          />
        </div>
      </PopupColumn>
      <PopupColumn label="compact tile: the master, or the only room's line">
        <div class="cast-list">
          <Group rooms={three()} master={master} compact />
          <Group rooms={castRooms([{ name: 'Study', volume: 18 }])} compact />
        </div>
      </PopupColumn>
    </div>
  );
}

/* --------------------------------------------------------------- VideoSync */

/**
 * A VideoSync holding its own switch, phase, trim and fold, as the popup does: on shows
 * Locking on… at once, off clears everything, and the action moves the phase to locking.
 * @param props - Component props
 * @param props.phase - Where it stands at first; undefined until the background answers
 * @param props.on - On at first
 * @param props.reason - Why, in words
 * @param props.action - The action's words, if any
 * @param props.open - Fine-tune open at first
 * @returns The row
 */
function Sync({
  phase: startPhase,
  on: startOn = true,
  reason: startReason,
  action,
  open: startOpen = false,
}: {
  phase?: VideoSyncPhase;
  on?: boolean;
  reason?: string;
  action?: string;
  open?: boolean;
}): JSX.Element {
  const [on, setOn] = useState(startOn);
  const [phase, setPhase] = useState(startPhase);
  const [reason, setReason] = useState(startReason);
  const [trim, setTrim] = useState(120);
  const [open, setOpen] = useState(startOpen);
  const lock = (): void => {
    setPhase('locking');
    setReason(undefined);
  };
  return (
    <VideoSync
      on={on}
      phase={phase}
      reason={reason}
      action={action && reason ? { label: action, onPress: lock } : undefined}
      trim={trim}
      onToggle={(next) => {
        setOn(next);
        if (next) lock();
        else {
          setPhase('off');
          setReason(undefined);
        }
      }}
      onTrim={setTrim}
      fineTuneOpen={open}
      onFineTuneChange={setOpen}
      strings={SYNC}
    />
  );
}

/**
 * VideoSync: off, not answered yet, each phase, and the three kinds of trouble (no action,
 * Reload page, Try again with Fine-tune open).
 * @returns The specimen
 */
export function VideoSyncSpecimen(): JSX.Element {
  return (
    <div class="popup-specimens">
      <PopupColumn label="off; not answered yet; locking on; in step; nothing to watch">
        <div class="cast-list">
          <Sync phase="off" on={false} />
          <Sync />
          <Sync phase="locking" />
          <Sync phase="in-step" />
          <Sync phase="no-video" />
        </div>
      </PopupColumn>
      <PopupColumn label="cannot sync (PCM only); cannot sync (reload); turned off">
        <div class="cast-list">
          <Sync phase="unavailable" reason={SYNC_EXTRA.pcmOnly} />
          <Sync phase="unavailable" reason={SYNC_EXTRA.reloadReason} action={SYNC_EXTRA.reload} />
          <Sync phase="turned-off" reason={SYNC_EXTRA.freeze} action={SYNC_EXTRA.tryAgain} open />
        </div>
      </PopupColumn>
    </div>
  );
}

/* ------------------------------------------------------------- PopupHeader */

const STATUS: Record<PopupConnection, string> = {
  connected: 'Connected to the desktop app',
  checking: 'Looking for a companion…',
  reconnecting: 'Asking the companion again…',
  disconnected: 'Not connected',
};

/**
 * PopupHeader: connected (desktop app and server), casting (the lit mark), an update marked
 * on Settings, checking, reconnecting and not connected. Never a count.
 * @returns The specimen
 */
export function PopupHeaderSpecimen(): JSX.Element {
  const head = (
    connection: PopupConnection,
    live = false,
    text = STATUS[connection],
    update = false,
  ): JSX.Element => (
    <PopupHeader
      name="Thaumic Cast"
      connection={connection}
      statusText={text}
      description={
        connection === 'reconnecting'
          ? 'The companion has stopped answering. Thaumic Cast is asking again.'
          : undefined
      }
      live={live}
      onSettings={noop}
      settingsLabel="Settings"
      updateLabel={update ? 'Settings, update available' : undefined}
    />
  );
  // On the popup's ground at its row width, as the popup draws it: not inside a card.
  return (
    <div class="popup-specimens">
      <div class="popup-specimen popup-ground">
        <p class="label">connected (desktop app, server), casting, an update on Settings</p>
        <div class="stack">
          {head('connected')}
          {head('connected', false, 'Connected to the server')}
          {head('connected', true)}
          {head('connected', false, STATUS.connected, true)}
        </div>
      </div>
      <div class="popup-specimen popup-ground">
        <p class="label">checking, reconnecting, not connected</p>
        <div class="stack">
          {head('checking')}
          {head('reconnecting', true)}
          {head('disconnected')}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------- Update available */

/**
 * Option 1, drawn for comparison only and not built: "Update available" as a link under the
 * status words. It is the PopupHeader's layout with a third line in the identity column.
 * @returns The header
 */
function HeaderWithUpdateLine(): JSX.Element {
  return (
    <header class="option-header">
      <div class="option-identity">
        <BrandBlock name="Thaumic Cast" lit={false} heading={false} />
        <p class="option-status">
          <StatusDot state="connected" />
          <span>Connected to the desktop app</span>
        </p>
        <span class="option-line">
          <Button kind="link" icon="external" onClick={noop}>
            Update available
          </Button>
        </span>
      </div>
      <IconButton kind="tonal" glyph="settings" label="Settings" onPress={noop} />
    </header>
  );
}

/**
 * "Update available" in the PopupHeader (owner call 3): option 2, the mark on Settings, is
 * built; option 1, a second status line, is drawn beside it for comparison. Both in a real
 * popup frame, before and after the version check lands.
 * @returns The specimen
 */
export function UpdateAvailableSpecimen(): JSX.Element {
  const shell = (header: JSX.Element): JSX.Element => (
    <div class="popup-frame">
      <PopupShell
        header={header}
        bar={
          <StickyActionBar>
            <Bar label="Cast to 1 room" />
          </StickyActionBar>
        }
      >
        <Tab />
      </PopupShell>
    </div>
  );
  const marked = (update: boolean): JSX.Element => (
    <PopupHeader
      name="Thaumic Cast"
      connection="connected"
      statusText="Connected to the desktop app"
      live={false}
      onSettings={noop}
      settingsLabel="Settings"
      updateLabel={update ? 'Settings, update available' : undefined}
    />
  );
  return (
    <div class="popup-specimens">
      <div class="popup-specimen" data-option="2">
        <p class="label">
          option 2, built: a mark on Settings, named "Settings, update available", with its Tooltip;
          it opens Settings at About. Nothing moves when it appears.
        </p>
        {shell(marked(true))}
      </div>
      <div class="popup-specimen" data-option="1">
        <p class="label">
          option 1, not built: a second status line. The header grows by a line when the version
          check lands, under the pointer, or keeps an empty line on every open.
        </p>
        {shell(<HeaderWithUpdateLine />)}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- CastBar */

/**
 * A CastBar whose actions run until shown otherwise.
 * @param props - The bar
 * @returns The bar
 */
function Bar(props: Partial<CastBarProps> & { label: string }): JSX.Element {
  const [failure, setFailure] = useState(props.failure);
  return (
    <CastBar
      mode="cast"
      busyLabel="Starting…"
      onCast={() => new Promise((resolve) => setTimeout(resolve, 1200))}
      dismissLabel="Dismiss"
      {...props}
      failure={failure && { ...failure, onDismiss: () => setFailure(undefined) }}
    />
  );
}

/**
 * CastBar: nothing chosen, ready with no line, one line, and the three (leaves, restarts, the
 * replace hint), an older companion's "plays too", busy, failed, add mode, and not connected.
 * @returns The specimen
 */
export function CastBarSpecimen(): JSX.Element {
  return (
    <div class="popup-specimens">
      <PopupColumn label="nothing chosen; ready, no line and one line; leaves, restarts and the hint; an older companion">
        <Bar
          label="Cast"
          disabled
          lines={['No room is chosen, and a cast has to go somewhere. Choose one.']}
        />
        <Bar label="Cast to 1 room" />
        <Bar label="Cast to 4 rooms" lines={['Whatever the speaker is playing will stop.']} />
        <Bar
          label="Cast to 2 rooms"
          lines={[
            'Kitchen leaves its Sonos group until you stop.',
            'Music in Patio starts again from the top.',
            'Whatever the speaker is playing will stop.',
          ]}
        />
        <Bar
          label="Cast to 3 rooms"
          lines={[
            'Patio plays too, as it is grouped with Kitchen.',
            'Whatever the speaker is playing will stop.',
          ]}
        />
      </PopupColumn>
      <PopupColumn label="busy; failed; add mode; not connected">
        <PressedOnMount>
          <Bar label="Cast to 2 rooms" onCast={never} />
        </PressedOnMount>
        <Bar
          label="Cast to 2 rooms"
          failure={{
            lead: 'The cast did not start',
            text: 'Trying again costs nothing and sometimes works.',
            onDismiss: noop,
          }}
        />
        <Bar
          label="Cast"
          mode="add"
          add={{
            label: 'Add 2 rooms',
            name: 'Add 2 rooms to Album title',
            busyLabel: 'Adding…',
            onAdd: never,
            cancelLabel: 'Cancel',
            onCancel: noop,
          }}
        />
        <Bar label="Cast" disabled />
      </PopupColumn>
    </div>
  );
}

/* -------------------------------------------------------------- NoticeSlot */

const slotItems: NoticeSlotItem[] = [
  {
    id: 'low',
    tone: 'warning',
    lead: 'Kitchen may cut out soon',
    text: 'Restarting the cast refills it.',
    details: { label: 'Details', content: 'The speaker is close to running out of audio.' },
    onDismiss: noop,
  },
  {
    id: 'cut',
    tone: 'warning',
    lead: 'Patio cut out',
    text: 'Raise the speaker head start to 1200 ms.',
    details: { label: 'Details', content: 'The speaker ran out of audio and went quiet.' },
    onDismiss: noop,
  },
  {
    id: 'gaps',
    tone: 'warning',
    lead: 'Gaps in the sound',
    details: { label: 'Details', content: 'The browser sent the audio late.' },
    onDismiss: noop,
  },
];

/**
 * NoticeSlot: one item in full; three (the first in full, the rest lines); the compact
 * tile's one slot line.
 * @returns The specimen
 */
export function NoticeSlotSpecimen(): JSX.Element {
  return (
    <div class="popup-specimens">
      <PopupColumn label="one item; three in slot order">
        <div class="cast-list">
          <NoticeSlot items={slotItems.slice(1, 2)} dismissLabel="Dismiss" />
          <NoticeSlot items={slotItems} dismissLabel="Dismiss" />
        </div>
      </PopupColumn>
      <PopupColumn label="compact: one slot line that opens the tile">
        <div class="cast-list">
          <NoticeSlot
            items={slotItems}
            compact
            onOpenTile={noop}
            openLabel={(lead) => `${lead}: open this cast`}
          />
        </div>
      </PopupColumn>
    </div>
  );
}

/* -------------------------------------------------------------- RoomPicker */

const FOUR = ['Kitchen', 'Living Room', 'Patio', 'Study'];
const FOURTEEN = [
  'Attic',
  'Bathroom',
  'Bedroom',
  'Dining Room',
  'Garage',
  'Garden',
  'Hall',
  'Kitchen',
  'Landing',
  'Living Room',
  'Nursery',
  'Patio',
  'Playroom',
  'Study',
];
const LEVELS: Record<string, number | undefined> = {
  Kitchen: 25,
  'Living Room': 72,
  Patio: 41,
  Study: 18,
  Bedroom: undefined,
};

/**
 * A RoomPicker that holds its own choice, fold, search, StartLevels and save form.
 * @param props - Component props
 * @param props.names - The rooms' names
 * @param props.chosen - Chosen at first
 * @param props.foldOpen - The fold open at first
 * @param props.query - The search at first
 * @param props.saveOpen - The save form open at first
 * @param props.saveError - The save form's error
 * @param props.partial - A set with a room that does not answer
 * @param props.state - The picker's state
 * @returns The picker
 */
function Picker({
  names,
  chosen: startChosen = [],
  foldOpen: startFold = false,
  query: startQuery = '',
  saveOpen = false,
  saveError,
  partial = false,
  state = 'ready',
}: {
  names: string[];
  chosen?: string[];
  foldOpen?: boolean;
  query?: string;
  saveOpen?: boolean;
  saveError?: string;
  partial?: boolean;
  state?: RoomPickerProps['state'];
}): JSX.Element {
  const [chosen, setChosen] = useState(startChosen);
  const [fold, setFold] = useState(startFold);
  const [query, setQuery] = useState(startQuery);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState(saveOpen);
  const [name, setName] = useState('');
  const same = (a: string[], b: string[]): boolean =>
    a.length === b.length && a.every((x) => b.includes(x));
  const last = ['Kitchen', 'Patio'];
  const sets: PickerSet[] = [
    {
      id: 'last',
      name: 'Last cast',
      kind: 'last',
      trail: '2 rooms',
      pressed: same(chosen, last),
      description: partial ? 'Patio is not answering; Kitchen goes alone.' : undefined,
    },
    {
      id: 'evenings',
      name: 'Evenings',
      kind: 'saved',
      trail: '1 room',
      pressed: same(chosen, ['Living Room']),
    },
    {
      id: 'everywhere',
      name: 'Everywhere',
      kind: 'everywhere',
      trail: `${names.length} rooms`,
      pressed: same(chosen, names),
    },
  ];
  const choose = (id: string): void =>
    setChosen(id === 'last' ? last : id === 'evenings' ? ['Living Room'] : names);
  return (
    <RoomPicker
      rooms={names.map((n) => ({
        room: room(n),
        grouped: n === 'Patio' ? 'Grouped with Kitchen' : undefined,
        badge: n === 'Garage' ? { tone: 'warning', label: 'No answer' } : undefined,
        unavailable: n === 'Garage',
        level: { now: n in LEVELS ? LEVELS[n] : 30 },
        limit: 30,
        checked: chosen.includes(n),
        onCheckedChange: (on) => setChosen((c) => (on ? [...c, n] : c.filter((x) => x !== n))),
        startOpen: open === n,
        onStartOpenChange: (o) => setOpen(o ? n : null),
      }))}
      sets={sets}
      onSet={choose}
      foldOpen={fold}
      onFoldChange={setFold}
      query={query}
      onQuery={setQuery}
      save={{
        shown: chosen.length >= 2 && !sets.some((s) => s.pressed),
        open: form,
        name,
        error: saveError,
        onOpen: () => setForm(true),
        onName: setName,
        onSave: () => setForm(false),
        onCancel: () => setForm(false),
      }}
      state={state}
      strings={PICKER}
    />
  );
}

/**
 * RoomPicker: four rooms with the sets (Last cast pressed, a set with a room not answering,
 * the save offer and its form), fourteen rooms folded shut and open with a search that hides
 * chosen rooms, and the loading, empty and not connected states.
 * @returns The specimen
 */
export function RoomPickerSpecimen(): JSX.Element {
  return (
    <div class="popup-specimens">
      <PopupColumn label="4 rooms: Last cast pressed; a StartLevel open">
        <Picker names={FOUR} chosen={['Kitchen', 'Patio']} />
      </PopupColumn>
      <PopupColumn label="a set missing a room; save offered, the form with its error">
        <Picker
          names={FOUR}
          chosen={['Kitchen', 'Study', 'Living Room']}
          partial
          saveOpen
          saveError="A set needs a name."
        />
      </PopupColumn>
      <PopupColumn label="14 rooms, the fold shut: only the chosen rooms">
        <Picker names={FOURTEEN} chosen={['Kitchen', 'Study', 'Bedroom']} />
      </PopupColumn>
      <PopupColumn label="14 rooms, the fold open, searching “room”">
        <Picker names={FOURTEEN} chosen={['Kitchen', 'Study', 'Bedroom']} foldOpen query="room" />
      </PopupColumn>
      <PopupColumn label="loading; no speakers; not connected">
        <Picker names={FOUR} state="loading" />
        <Picker names={FOUR} state="empty" />
        <Picker names={FOUR} state="disconnected" />
      </PopupColumn>
    </div>
  );
}

/* ------------------------------------------------------- TabCard, CastTile */

/**
 * The TabCard's picker, holding its own state (four rooms, Last cast chosen).
 * @param props - Component props
 * @param props.kind - tab, or browser for browser-wide capture
 * @returns The card
 */
function Tab({ kind = 'tab' }: { kind?: 'tab' | 'browser' }): JSX.Element {
  const [chosen, setChosen] = useState(['Kitchen']);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <TabCard
      media={
        kind === 'browser'
          ? {
              kind,
              title: 'Whole browser',
              subtitle: 'Browser-wide capture',
              playing: true,
              strings: MEDIA,
            }
          : {
              kind,
              art: poster(SEEDS.video),
              title: 'Video title',
              subtitle: 'youtube.com',
              playing: true,
              strings: MEDIA,
            }
      }
      picker={{
        rooms: FOUR.map((n) => ({
          room: room(n),
          level: { now: LEVELS[n] },
          limit: 30,
          checked: chosen.includes(n),
          onCheckedChange: (on) => setChosen((c) => (on ? [...c, n] : c.filter((x) => x !== n))),
          startOpen: open === n,
          onStartOpenChange: (o) => setOpen(o ? n : null),
        })),
        sets: [
          {
            id: 'last',
            name: 'Last cast',
            kind: 'last',
            trail: '1 room',
            pressed: chosen.join() === 'Kitchen',
          },
          {
            id: 'everywhere',
            name: 'Everywhere',
            kind: 'everywhere',
            trail: '4 rooms',
            pressed: chosen.length === 4,
          },
        ],
        onSet: (id) => setChosen(id === 'last' ? ['Kitchen'] : FOUR),
        foldOpen: false,
        onFoldChange: noop,
        query: '',
        onQuery: noop,
        state: 'ready',
        strings: PICKER,
      }}
    />
  );
}

/**
 * TabCard: the tab's head over the picker, and the browser-wide kind.
 * @returns The specimen
 */
export function TabCardSpecimen(): JSX.Element {
  return (
    <div class="popup-specimens">
      <div class="popup-specimen popup-ground">
        <p class="label">tab</p>
        <Tab />
      </div>
      <div class="popup-specimen popup-ground">
        <p class="label">browser-wide capture</p>
        <Tab kind="browser" />
      </div>
    </div>
  );
}

/**
 * A CastTile holding its own open state, volume fold and add list.
 * @param props - The tile's starting state
 * @param props.title - The media title
 * @param props.seed - The artwork seed; none for a cast with no artwork (and no band)
 * @param props.rooms - The rooms
 * @param props.open - Open at first
 * @param props.single - A single cast: no chevron
 * @param props.slot - Problems in the slot
 * @param props.note - A tile note
 * @param props.sync - Video sync on
 * @returns The tile
 */
function Tile({
  title,
  seed,
  rooms: names,
  open: startOpen = false,
  single = false,
  slot = [],
  note = false,
  sync = false,
}: {
  title: string;
  seed?: readonly [number, number, number];
  rooms: string[];
  open?: boolean;
  single?: boolean;
  slot?: NoticeSlotItem[];
  note?: boolean;
  sync?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(startOpen);
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [trim, setTrim] = useState(120);
  const [notes, setNotes] = useState(note);
  const rooms = castRooms(names.map((name, i) => ({ name, volume: 20 + 9 * i })));
  const props: CastTileProps = {
    media: {
      kind: 'tab',
      art: seed && poster(seed),
      title,
      subtitle: names.join(' + '),
      playing: true,
      band: seed && artBand(seed),
      transport,
      onGoToTab: noop,
      strings: MEDIA,
    },
    open: single || open,
    onOpenChange: single ? undefined : setOpen,
    stop: { label: 'Stop', name: `Stop casting ${title}`, onStop: never },
    volume: {
      rooms,
      master:
        names.length > 1 ? { name: names.join(' + '), onVolume: noop, onMute: noop } : undefined,
      expanded,
      onExpandedChange: setExpanded,
      add: { open: adding, onOpenChange: setAdding, rooms: addable },
      strings: GROUP,
    },
    notices: {
      items: slot,
      openLabel: (lead) => `${lead}: open this cast`,
      dismissLabel: 'Dismiss',
    },
    notes: notes
      ? [
          {
            id: 'left',
            tone: 'info',
            lead: 'Patio left this cast',
            details: { label: 'Details', content: 'The speaker was taken by another app.' },
            onDismiss: () => setNotes(false),
            dismissLabel: 'Dismiss',
          },
        ]
      : [],
    videoSync: sync
      ? {
          on: true,
          phase: 'in-step',
          trim,
          onToggle: noop,
          onTrim: setTrim,
          strings: SYNC,
        }
      : undefined,
  };
  return <CastTile {...props} />;
}

/**
 * CastTile: a single cast open with no chevron; several rooms open with video sync and a
 * tile note; compact tiles with and without a slot line; the red guard; a cast with no
 * artwork, open and compact.
 * @returns The specimen
 */
export function CastTileSpecimen(): JSX.Element {
  return (
    <div class="popup-specimens">
      <div class="popup-specimen popup-ground">
        <p class="label">a single cast: open, no chevron</p>
        <Tile title="Video title" seed={SEEDS.video} rooms={['Kitchen']} single />
      </div>
      <div class="popup-specimen popup-ground">
        <p class="label">three rooms, open: video sync, a tile note, the slot</p>
        <Tile
          title="Album title"
          seed={SEEDS.pastel}
          rooms={['Kitchen', 'Living Room', 'TV Room']}
          open
          sync
          note
          slot={slotItems.slice(1, 3)}
        />
      </div>
      <div class="popup-specimen popup-ground">
        <p class="label">two casts, compact: with a slot line, and without</p>
        <div class="stack">
          <Tile
            title="Album title"
            seed={SEEDS.pastel}
            rooms={['Kitchen', 'Patio']}
            slot={slotItems}
          />
          <Tile title="Mix title" seed={SEEDS.neon} rooms={['Study']} />
        </div>
      </div>
      <div class="popup-specimen popup-ground">
        <p class="label">the red guard: Stop off the band</p>
        <Tile title="Film title" seed={SEEDS.red} rooms={['TV Room']} open />
      </div>
      <div class="popup-specimen popup-ground" data-specimen="no-art">
        <p class="label">no artwork, so no band: the head row sits where it does compact</p>
        <div class="stack">
          <Tile title="Tone title" rooms={['Kitchen', 'Office']} open />
          <Tile title="Hum title" rooms={['Study']} />
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------- PopupShell, StickyActionBar */

/**
 * PopupShell and StickyActionBar: an idle popup that fits, and a long one that scrolls with
 * the banner, the away line, two casts, the TabCard and a Toast in the bar, with an update
 * marked on Settings. Each frame is the real popup size (22rem by at most 37.5rem).
 * @returns The specimen
 */
export function PopupShellSpecimen(): JSX.Element {
  const [toast, setToast] = useState(true);
  const header = (live: boolean): JSX.Element => (
    <PopupHeader
      name="Thaumic Cast"
      connection="connected"
      statusText="Connected to the desktop app"
      live={live}
      onSettings={noop}
      settingsLabel="Settings"
      updateLabel={live ? 'Settings, update available' : undefined}
    />
  );
  return (
    <div class="popup-specimens">
      <div class="popup-specimen">
        <p class="label">idle: it fits, so the bar draws no hairline (where scroll-state exists)</p>
        <div class="popup-frame" data-frame="idle">
          <PopupShell
            header={header(false)}
            bar={
              <StickyActionBar>
                <Bar label="Cast to 1 room" />
              </StickyActionBar>
            }
          >
            <Tab />
          </PopupShell>
        </div>
      </div>
      <div class="popup-specimen">
        <p class="label">long: one scroller; the bar sticks, with its hairline, at the end</p>
        <div class="popup-frame" data-frame="long">
          <PopupShell
            header={header(true)}
            banner={
              <Notice
                kind="banner"
                tone="warning"
                lead="This companion is older than the extension"
                text="It is on v0.11.0, and it may still work. If anything misbehaves, update it."
                action={{ label: 'Update desktop app', onClick: noop }}
                onDismiss={noop}
              />
            }
            away={
              <NoticeLine
                tone="info"
                glyph="history"
                srPrefix="While you were away:"
                lead="Cast to Bedroom ended"
                details={{ label: '2 more', content: 'Two more things happened.' }}
                onDismiss={noop}
              />
            }
            bar={
              <StickyActionBar
                toast={
                  toast && (
                    <Toast
                      text="Patio left this cast"
                      action={{ label: 'Undo', onClick: () => setToast(false) }}
                      onDismiss={() => setToast(false)}
                    />
                  )
                }
              >
                <Bar
                  label="Cast to 2 rooms"
                  lines={['Patio leaves its Sonos group until you stop.']}
                />
              </StickyActionBar>
            }
          >
            <SectionHeader kind="live" level={2} title="Casting now" />
            <Tile
              title="Album title"
              seed={SEEDS.pastel}
              rooms={['Kitchen', 'Patio']}
              open
              slot={slotItems.slice(1, 2)}
            />
            <Tile title="Mix title" seed={SEEDS.neon} rooms={['Study']} slot={slotItems} />
            <Tab />
          </PopupShell>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- container frames */

/**
 * The popup's components in compact (22rem), medium (36rem) and wide (52rem) frames, in the
 * popup and desktop densities: none of them has a container query of its own, so each one
 * fills its frame, wraps and never overflows.
 * @returns The frames
 */
export function PopupFramesSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <Frames title="RoomRow pick, in a picker">
        {() => <Picker names={FOUR} chosen={['Kitchen', 'Patio']} />}
      </Frames>
      <Frames title="GroupVolume, the fold open">
        {() => (
          <Group
            rooms={three()}
            master={{ name: 'Kitchen + Living Room + TV Room', onVolume: noop, onMute: noop }}
            expanded
          />
        )}
      </Frames>
      <Frames title="CastTile, open on the band">
        {() => (
          <Tile
            title="Album title"
            seed={SEEDS.pastel}
            rooms={['Kitchen', 'Patio']}
            open
            slot={slotItems.slice(1, 3)}
          />
        )}
      </Frames>
      <Frames title="CastBar with its line and a failure">
        {() => (
          <Bar
            label="Cast to 2 rooms"
            lines={['Patio leaves its Sonos group until you stop.']}
            failure={{ lead: 'The cast did not start', onDismiss: noop }}
          />
        )}
      </Frames>
    </div>
  );
}
