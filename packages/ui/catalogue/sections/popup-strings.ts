/**
 * The popup's English words, for the catalogue only. The UI package holds no locale: the
 * extension passes these from its own `en.json` (the key is in each comment there).
 */
import type { RoomPickerStrings } from '../../src/RoomPicker';
import type { StartLevelStrings } from '../../src/StartLevel/start';
import type { GroupVolumeStrings } from '../../src/GroupVolume';
import type { MediaHeaderStrings } from '../../src/MediaHeader';
import type { VideoSyncStrings } from '../../src/VideoSync';
import type { RoomRowCastStrings } from '../../src/RoomRow';

/** The start level's words (P-start). */
export const START: StartLevelStrings = {
  label: (name) => `${name} start level`,
  caption: (now, start) => `Now ${now}; starts at ${start}`,
  capped: (now, limit) => `Now ${now}; starts at your limit of ${limit}`,
  cappedFrom: (now) => `capped from ${now}`,
  nowShort: (now) => `now ${now}`,
  levelNow: (now) => `at ${now} now`,
  startsAt: (start) => `starts at ${start}`,
  unknown: (limit) =>
    limit === null ? 'not known yet' : `not known yet; starts no louder than ${limit}`,
  fixed: 'Fixed',
  fixedSpoken: 'fixed level; turn the amplifier instead',
};

/** A cast row's words. */
export const CAST_ROW: RoomRowCastStrings = {
  mute: (name) => `Mute ${name}`,
  volume: (name) => `${name} volume`,
  unknown: 'Not known yet',
  fixed: 'fixed level; turn the amplifier instead',
  remove: (name) => `Remove ${name}`,
  joining: (name) => `${name} is joining…`,
  dismiss: 'Dismiss',
};

/** A media head's words. */
export const MEDIA: MediaHeaderStrings = {
  previous: 'Previous track',
  next: 'Next track',
  play: 'Play',
  pause: 'Pause',
  goToTab: 'Go to tab',
};

/** A cast's volume words. */
export const GROUP: GroupVolumeStrings = {
  ...CAST_ROW,
  muted: 'muted',
  condition: (name, word) => `${name} ${word.toLowerCase()}`,
  roomsCount: (count) => (count === 1 ? '1 room' : `${count} rooms`),
  addRoom: 'Add a room',
  addLegend: 'Add to this cast',
  start: START,
};

/** Video sync's words (main's locale), with Fine-tune for the specimen's first room. */
export const SYNC: VideoSyncStrings = {
  label: 'Video sync',
  phases: {
    locking: 'Locking on…',
    'in-step': 'In step',
    'no-video': 'Nothing to watch',
    unavailable: 'Cannot sync',
    'turned-off': 'Turned off',
  },
  fineTune: 'Fine-tune for Living Room',
  ms: (trim) => `${trim > 0 ? '+' : ''}${trim} ms`,
  trimWords: (trim) =>
    trim === 0
      ? 'No adjustment'
      : trim > 0
        ? `Sound ${trim} ms earlier`
        : `Sound ${-trim} ms later`,
};

/** Video sync's reasons and actions, as the extension's locale words them. */
export const SYNC_EXTRA = {
  pcmOnly:
    'Only PCM casts keep good enough time. Under Settings, set Quality to Bespoke and choose PCM.',
  reloadReason: 'This page was open before video sync was on. Reload it.',
  freeze: 'The video stuck, so the sound went back where it was.',
  reload: 'Reload page',
  tryAgain: 'Try again',
};

/** The picker's words. */
export const PICKER: RoomPickerStrings = {
  legend: 'Cast to',
  rooms: 'Rooms',
  chosen: (count, total) => `${count} of ${total} chosen`,
  roomsCount: (count) => (count === 1 ? '1 room' : `${count} rooms`),
  findRoom: 'Find a room',
  clearSearch: 'Clear search',
  hiddenChosen: (count) =>
    count === 1
      ? '1 chosen room is hidden by the search, and still chosen.'
      : `${count} chosen rooms are hidden by the search, and still chosen.`,
  saveSet: 'Save these rooms as a set',
  nameSet: 'Name this set',
  save: 'Save',
  cancel: 'Cancel',
  waiting: 'Speakers are listed here once the companion answers.',
  empty:
    'No speaker answered. Check they are switched on, and on the same network as the companion.',
  loading: 'Asking for speakers…',
  start: START,
};
