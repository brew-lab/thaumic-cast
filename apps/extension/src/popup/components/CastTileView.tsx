import type { JSX } from 'preact';
import { useCallback, useRef } from 'preact/hooks';
import type { ActiveCast, MediaAction } from '@thaumic-cast/protocol';
import { getDisplayImage, getDisplayTitle } from '@thaumic-cast/protocol';
import { CastTile, artBand, type CastTileProps, type MediaTransport } from '@thaumic-cast/ui';
import { videoSyncAction } from '../../lib/video-sync-view';
import { useDominantColor } from '../hooks/useDominantColor';
import { useOptimisticOverlay } from '../hooks/useOptimisticOverlay';
import { useVideoSyncState } from '../hooks/useVideoSyncState';
import type { PopupWords } from '../hooks/useWords';

/** Presses this close together on one transport control count once. */
const CONTROL_DEBOUNCE_MS = 300;

/** Props for {@link CastTileView}. */
export interface CastTileViewProps extends Omit<
  CastTileProps,
  'media' | 'videoSync' | 'id' | 'stop'
> {
  /** The cast. */
  cast: ActiveCast;
  /** The rooms it plays in, joined: the tile's subtitle. */
  roomsName: string;
  /** Stops the cast. */
  onStop: () => Promise<unknown>;
  /** The tile's id, so focus can find its Stop. */
  id: string;
  /** The words. */
  words: PopupWords;
  /** Video sync's Fine-tune is open (kept by the popup for its session). */
  fineTuneOpen?: boolean;
  /** Opens or shuts video sync's Fine-tune. */
  onFineTuneChange?: (open: boolean) => void;
  /** The popup is open over the cast's own tab, so there is no Go to tab. */
  onItsTab?: boolean;
}

/**
 * One running cast as a CastTile: what it plays (its artwork-seeded band, the
 * transport and, from another tab, Go to tab), Stop, and video sync when the cast has it. The
 * rest of the tile (volume, slot, notes) comes from the popup.
 * @param props - Component props
 * @param props.cast - The cast
 * @param props.roomsName - Its rooms, joined
 * @param props.onStop - Stops it
 * @param props.id - The tile's id
 * @param props.words - The words
 * @param props.fineTuneOpen - Video sync's Fine-tune is open
 * @param props.onFineTuneChange - Opens or shuts it
 * @param props.onItsTab - The popup is open over the cast's tab
 * @returns The tile
 */
export function CastTileView({
  cast,
  roomsName,
  onStop,
  id,
  words,
  fineTuneOpen,
  onFineTuneChange,
  onItsTab = false,
  ...tile
}: CastTileViewProps): JSX.Element {
  const { t } = words;
  const browser = cast.captureMode === 'browser';
  const state = cast.mediaState;
  const title = browser ? t('whole_browser') : getDisplayTitle(state);
  const image = getDisplayImage(state);
  const actions = state.supportedActions ?? [];
  const [playing, setOptimisticPlaying] = useOptimisticOverlay(state.playbackState === 'playing');
  const dominant = useDominantColor(image);
  const sync = useVideoSyncState(cast.videoSync ? cast.tabId : undefined);
  const syncPhase = sync.known ? sync.state : undefined;
  const syncAction = videoSyncAction(syncPhase, sync.reason);
  const lastPress = useRef<Record<string, number>>({});

  const control = useCallback(
    (action: MediaAction) => {
      const now = Date.now();
      if (now - (lastPress.current[action] ?? 0) < CONTROL_DEBOUNCE_MS) return;
      lastPress.current[action] = now;
      if (action === 'play') setOptimisticPlaying(true);
      if (action === 'pause') setOptimisticPlaying(false);
      chrome.runtime.sendMessage({ type: 'CONTROL_MEDIA', payload: { tabId: cast.tabId, action } });
    },
    [cast.tabId],
  );

  const transport: MediaTransport = {
    canPrev: actions.includes('previoustrack'),
    canNext: actions.includes('nexttrack'),
    canPlayPause: actions.includes('play') || actions.includes('pause'),
    onPrev: () => control('previoustrack'),
    onNext: () => control('nexttrack'),
    onPlayPause: () => control(playing ? 'pause' : 'play'),
  };

  return (
    <CastTile
      {...tile}
      id={id}
      media={{
        kind: browser ? 'browser' : 'tab',
        art: image,
        title,
        subtitle: roomsName,
        playing,
        band: dominant ? artBand(dominant.oklch) : undefined,
        transport,
        // Go to tab only from another tab: on the cast's own tab it would go nowhere.
        onGoToTab: onItsTab
          ? undefined
          : () => {
              chrome.tabs.update(cast.tabId, { active: true });
            },
        strings: words.media,
      }}
      stop={{
        label: t('stop_cast'),
        name: t('stop_cast_named', { title }),
        onStop,
      }}
      videoSync={
        cast.videoSync
          ? {
              on: sync.enabled,
              phase: syncPhase,
              reason: sync.reason && words.sync.reason(sync.reason),
              action:
                syncAction === 'reload'
                  ? { label: words.sync.reload, onPress: sync.reloadPage }
                  : syncAction === 'try-again'
                    ? { label: words.sync.tryAgain, onPress: sync.tryAgain }
                    : undefined,
              trim: sync.trimMs,
              onToggle: sync.setEnabled,
              onTrim: sync.setTrim,
              fineTuneOpen,
              onFineTuneChange,
              strings: {
                ...words.sync,
                fineTune: words.sync.fineTune(sync.speakerName ?? cast.speakerNames[0] ?? ''),
              },
            }
          : undefined
      }
    />
  );
}
