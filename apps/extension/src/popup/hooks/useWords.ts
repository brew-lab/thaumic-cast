import { useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type {
  GroupVolumeStrings,
  MediaHeaderStrings,
  RoomPickerStrings,
  StartLevelStrings,
  VideoSyncStrings,
} from '@thaumic-cast/ui';
import type { VideoSyncReason } from '@thaumic-cast/protocol';
import type { Words } from '../../lib/popup-notices';
import { videoSyncReasonKey } from '../../lib/video-sync-view';

/** Video sync's words: VideoSync's own, with the Fine-tune name and the app's extras. */
export interface PopupSyncWords extends Omit<VideoSyncStrings, 'fineTune'> {
  /** "Fine-tune for {{speaker}}". */
  fineTune: (speaker: string) => string;
  /** A reason's sentence. */
  reason: (reason: VideoSyncReason) => string;
  /** "Reload page". */
  reload: string;
  /** "Try again". */
  tryAgain: string;
}

/** Every word set the popup's components take, from the locale. */
export interface PopupWords {
  /** Translates a key with its values. */
  t: (key: string, params?: Record<string, unknown>) => string;
  /** Translates the words a pure rule chose. */
  say: (words: Words) => string;
  /** Joins names into a list: "Kitchen", "Kitchen and Patio", "Kitchen, Patio and Study". */
  list: (names: readonly string[]) => string;
  /** The start level's words. */
  start: StartLevelStrings;
  /** The picker's words. */
  picker: RoomPickerStrings;
  /** A cast's volume words. */
  group: GroupVolumeStrings;
  /** A media head's words. */
  media: MediaHeaderStrings;
  /** Video sync's words. */
  sync: PopupSyncWords;
}

/**
 * The popup's words, from the extension's locale: the UI package holds none,
 * so each component takes its words as props.
 * @returns The words
 */
export function useWords(): PopupWords {
  const { t: translate, i18n } = useTranslation();
  return useMemo(() => {
    const t = (key: string, params?: Record<string, unknown>): string =>
      translate(key, { defaultValue: key, ...params });
    const listFormat = new Intl.ListFormat(i18n.language || 'en', {
      style: 'long',
      type: 'conjunction',
    });
    const start: StartLevelStrings = {
      label: (name) => t('start_level_speaker', { name }),
      caption: (now, level) => t('start_level_caption', { now, start: level }),
      capped: (now, limit) => t('start_level_capped', { now, limit }),
      cappedFrom: (now) => t('start_level_capped_from', { now }),
      nowShort: (now) => t('start_level_now_short', { now }),
      levelNow: (level) => t('room_level_now', { level }),
      startsAt: (level) => t('start_level_starts_at', { start: level }),
      unknown: (limit) =>
        limit === null ? t('volume_not_known') : t('start_level_unknown', { limit }),
      fixed: t('volume_fixed'),
      fixedSpoken: t('volume_fixed_hint'),
    };
    const roomsCount = (count: number): string => t('rooms_count', { count });
    return {
      t,
      say: (words) => t(words.key, words.params),
      list: (names) => listFormat.format(names),
      start,
      picker: {
        legend: t('target_speaker'),
        rooms: t('rooms_label'),
        chosen: (count, total) => t('rooms_chosen', { count, total }),
        roomsCount,
        findRoom: t('find_room'),
        clearSearch: t('clear_search'),
        hiddenChosen: (count) => t('hidden_chosen', { count }),
        saveSet: t('save_set'),
        nameSet: t('name_set'),
        save: t('save'),
        cancel: t('cancel'),
        waiting: t('picker_waiting'),
        empty: t('no_speakers_found'),
        loading: t('loading_speakers'),
        start,
      },
      group: {
        mute: (name) => t('mute_speaker', { name }),
        volume: (name) => t('volume_speaker', { name }),
        unknown: t('volume_not_known'),
        fixed: t('volume_fixed_hint'),
        remove: (name) => t('remove_speaker', { name }),
        joining: (name) => t('room_joining', { name }),
        dismiss: t('dismiss'),
        muted: t('volume_summary_muted'),
        condition: (name, word) => t('room_condition', { name, word }),
        roomsCount,
        addRoom: t('add_room'),
        addLegend: t('add_to_cast'),
        start,
      },
      media: {
        previous: t('previous_track'),
        next: t('next_track'),
        play: t('play'),
        pause: t('pause'),
        goToTab: t('go_to_tab'),
      },
      sync: {
        label: t('video_sync'),
        phases: {
          locking: t('video_sync_status_acquiring'),
          'in-step': t('video_sync_status_synced'),
          'no-video': t('video_sync_status_no_video'),
          unavailable: t('video_sync_status_unavailable'),
          'turned-off': t('video_sync_status_turned_off'),
        },
        fineTune: (speaker) => t('video_sync_trim', { speaker }),
        ms: (trim) => t('video_sync_delay_ms', { delay: `${trim > 0 ? '+' : ''}${trim}` }),
        trimWords: (trim) =>
          trim === 0
            ? t('video_sync_trim_none')
            : trim > 0
              ? t('video_sync_trim_earlier', { delay: trim })
              : t('video_sync_trim_later', { delay: -trim }),
        reason: (reason) => t(videoSyncReasonKey(reason)),
        reload: t('video_sync_reload'),
        tryAgain: t('video_sync_try_again'),
      },
    };
  }, [translate, i18n.language]);
}
