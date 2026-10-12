import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ActiveCast, Room, RoomId } from '@thaumic-cast/protocol';
import {
  getDisplaySubtitle,
  getDisplayTitle,
  roomAvailability,
  roomLevel,
} from '@thaumic-cast/protocol';
import { GITHUB_RELEASES_URL } from '@thaumic-cast/shared';
import {
  Badge,
  Button,
  CastBar,
  Notice,
  PopupHeader,
  PopupShell,
  SectionHeader,
  StickyActionBar,
  TabCard,
  Toast,
  useAnnouncer,
  type BadgeTone,
  type GroupVolumeAddRoom,
  type GroupVolumeRoom,
  type NoticeSlotItem,
  type PickerRoom,
  type PopupConnection,
} from '@thaumic-cast/ui';
import type {
  AddRoomsMessage,
  AddRoomsResponse,
  CastAutoStoppedMessage,
  ExtensionResponse,
  SpeakerRemovedMessage,
  SpeakerStopFailedMessage,
  StartCastMessage,
} from '../lib/messages';
import { autoStopMessageKey } from '../lib/auto-stop-message';
import { planCast, playsTooLine } from '../lib/cast-plan';
import { castBarFailure, placeNotices, type SlotPlan, type Words } from '../lib/popup-notices';
import {
  addableRooms,
  castRows,
  masterTargets,
  replaceHint,
  scaleLevels,
  undoLevels,
  type CastRow,
} from '../lib/popup-rooms';
import { captureHealthAlert } from '../lib/popup-copy';
import { isWindowsPlatform } from '../lib/settings';
import { NO_REPLY_DISMISSED_KEY } from '../lib/speaker-notices';
import { noop } from '../lib/noop';
import { versionMismatchActionKey } from '../lib/versionCheck';
import { useChromeMessage } from './hooks/useChromeMessage';
import { useCurrentTabState } from './hooks/useCurrentTabState';
import { useActiveCasts } from './hooks/useActiveCasts';
import { useSonosState } from './hooks/useSonosState';
import { useConnectionStatus } from './hooks/useConnectionStatus';
import { useOnboarding } from './hooks/useOnboarding';
import { useCompanionVersion } from './hooks/useCompanionVersion';
import { useCaptureHealth } from './hooks/useCaptureHealth';
import { useSpeakerNotices } from './hooks/useSpeakerNotices';
import { useIngestGaps } from './hooks/useIngestGaps';
import { useRooms } from './hooks/useRooms';
import { useRoomChoice } from './hooks/useRoomChoice';
import { useStartLevels } from './hooks/useStartLevels';
import { useCastSettings } from './hooks/useCastSettings';
import { useAwayEvents } from './hooks/useAwayEvents';
import { useWords } from './hooks/useWords';
import { Onboarding } from './components/Onboarding';
import { CastTileView } from './components/CastTileView';
import { AwayLine } from './components/AwayLine';

/** The TabCard's id, so Stop can move focus to its heading (P-stop). */
const TAB_CARD_ID = 'this-tab';

/**
 * A row that joins waits this long for ADD_ROOMS to answer: longer than the background's own
 * worst case (it gives the offscreen document 30 s, start-level reads and a queued playback
 * start included), so the row never says "did not join" for a room that then plays.
 */
const JOIN_TIMEOUT_MS = 35_000;

/** Undo waits at most this long for the removal it undoes to land. */
const UNDO_WAIT_MS = 5_000;

/** A room joining a cast, until ADD_ROOMS answers. */
interface Joining {
  /** The room. */
  roomId: RoomId;
  /** Its name. */
  name: string;
  /** The level it joins at, or undefined while it is not known ("…"). */
  level?: number;
}

/** A room that did not join, until it does, or it is forgotten. */
interface JoinFailed {
  /** The room. */
  roomId: RoomId;
  /** Its name. */
  name: string;
  /** Its row line was dismissed (the Badge stays). */
  dismissed: boolean;
}

/** A note in a tile: a room that left the cast by itself (S7). */
interface TileNote {
  /** Its identity. */
  id: string;
  /** The room. */
  name: string;
  /** The shipped sentence's key. */
  key: string;
}

/** The Toast: one at a time, never on a timer (M-toast). */
interface ToastState {
  /** What happened. */
  text: string;
  /**
   * Undo after removing a row: re-adds its rooms, each at its own old level, once the row's
   * target has left the cast.
   */
  undo?: { tabId: number; ip: string; roomIds: RoomId[]; levels: Record<RoomId, number> };
}

/** The tile for the cast whose focus should land after Stop, or the TabCard. */
type PendingFocus = { kind: 'stop'; tileId: string; name: string } | { kind: 'tab' };

/**
 * Main Extension Popup UI.
 * @returns The rendered popup application
 */
export function App(): JSX.Element | null {
  const {
    isLoading: onboardingLoading,
    isComplete: onboardingComplete,
    completeOnboarding,
    skipOnboarding,
  } = useOnboarding();

  // P-states: nothing is painted until the stored state is read.
  if (onboardingLoading) return null;

  if (!onboardingComplete) {
    return <Onboarding onComplete={completeOnboarding} onSkip={skipOnboarding} />;
  }

  return <MainPopup />;
}

/**
 * The popup (DESIGN.md L-popup): the PopupHeader, the one banner, the away
 * line, "Casting now" with a CastTile per cast, the TabCard while this tab is
 * not casting, and the StickyActionBar holding the Toast and the CastBar.
 * Every notice sits at its source (P-notices).
 * @returns The rendered main popup
 */
function MainPopup(): JSX.Element {
  const words = useWords();
  const { t, say: sayWords, list } = words;
  const { say } = useAnnouncer();

  // ── Sources ────────────────────────────────────────────────────────────
  const connection = useConnectionStatus();
  const connected = connection.phase === 'connected';
  const { state: currentTab } = useCurrentTabState();
  const { casts, stopCast, removeSpeaker } = useActiveCasts();
  const castingIps = useMemo(() => casts.flatMap((cast) => cast.speakerIps), [casts]);
  const sonos = useSonosState();
  const rooms = useRooms(sonos.state);
  const choice = useRoomChoice(rooms, sonos.state, castingIps);
  const start = useStartLevels();
  const { limit, captureMode } = useCastSettings();
  const { companion, hasMismatch, showMismatchWarning, dismissMismatchWarning } =
    useCompanionVersion(connection);
  const capture = useCaptureHealth();
  const speakerNotices = useSpeakerNotices(casts, sonos.speakerGroups, {
    companionAudio: connection.companionAudio,
    appType: connection.appType,
  });
  const ingestGaps = useIngestGaps(casts, connection.appType);
  const away = useAwayEvents();

  // ── Popup state ────────────────────────────────────────────────────────
  const [castFailure, setCastFailure] = useState<{ lead: Words; text: Words } | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [tileOpen, setTileOpen] = useState<Record<number, boolean>>({});
  const [foldOpen, setFoldOpen] = useState<Record<number, boolean>>({});
  const [fineTuneOpen, setFineTuneOpen] = useState<Record<number, boolean>>({});
  const [addFor, setAddFor] = useState<number | null>(null);
  const [addChoice, setAddChoice] = useState<RoomId[]>([]);
  const [joining, setJoining] = useState<Record<number, Joining[]>>({});
  const [joinFailed, setJoinFailed] = useState<Record<number, JoinFailed[]>>({});
  const [stopFailed, setStopFailed] = useState<Record<string, { dismissed: boolean }>>({});
  const [notes, setNotes] = useState<Record<number, TileNote[]>>({});
  const [noReplyDismissed, setNoReplyDismissed] = useState(false);
  // Kept until the speakers answer again, so the toolbar badge drops it too.
  useEffect(() => {
    chrome.storage.local
      .get(NO_REPLY_DISMISSED_KEY)
      .then((stored) => setNoReplyDismissed(stored[NO_REPLY_DISMISSED_KEY] === true))
      .catch(noop);
  }, []);
  const dismissNoReply = useCallback(() => {
    setNoReplyDismissed(true);
    chrome.storage.local.set({ [NO_REPLY_DISMISSED_KEY]: true }).catch(noop);
  }, []);
  const [pickerFold, setPickerFold] = useState(false);
  const [query, setQuery] = useState('');
  const pendingFocus = useRef<PendingFocus | null>(null);
  // Every cast seen this popup session, as last seen, to name a cast after it has gone: the
  // background reports the new list before it says why a cast ended.
  const seenCasts = useRef(new Map<number, ActiveCast>());
  const castsNow = useRef(casts);
  castsNow.current = casts;

  const rowsOf = useCallback((cast: ActiveCast) => castRows(cast, rooms), [rooms]);
  const roomsNameOf = useCallback(
    (cast: ActiveCast) =>
      rowsOf(cast)
        .map((row) => row.name)
        .join(' + '),
    [rowsOf],
  );

  // ── Events while open ──────────────────────────────────────────────────
  useChromeMessage((message) => {
    const msg = message as { type: string };
    const previous = [...seenCasts.current.values()];
    if (msg.type === 'CAST_AUTO_STOPPED') {
      const stopped = message as CastAutoStoppedMessage;
      if (stopped.reason === 'user_removed') return;
      const cast = previous.find((c) => c.tabId === stopped.tabId);
      const speaker = sonos.speakerGroups.getGroupName(stopped.speakerIp);
      const name = cast ? roomsNameOf(cast) : speaker;
      setToast({
        text: `${t('cast_ended', { name })}. ${t(autoStopMessageKey(stopped.reason, false), {
          ...stopped.params,
          name: speaker,
        })}`,
      });
    } else if (msg.type === 'SPEAKER_REMOVED') {
      const removed = message as SpeakerRemovedMessage;
      if (removed.reason === 'user_removed') return;
      const cast = previous.find((c) => c.tabId === removed.tabId);
      const row = cast && rowsOf(cast).find((r) => r.ip === removed.speakerIp);
      const name = row?.name ?? sonos.speakerGroups.getGroupName(removed.speakerIp);
      setNotes((prev) => ({
        ...prev,
        [removed.tabId]: [
          ...(prev[removed.tabId] ?? []),
          {
            id: `${removed.speakerIp}:${Date.now()}`,
            name,
            key: autoStopMessageKey(removed.reason, true),
          },
        ],
      }));
    } else if (msg.type === 'SPEAKER_STOP_FAILED') {
      const failed = message as SpeakerStopFailedMessage;
      setStopFailed((prev) => ({ ...prev, [failed.speakerIp]: { dismissed: false } }));
    }
  });

  // A row line clears when its room leaves the cast; a cast's session state goes with it.
  useEffect(() => {
    for (const cast of casts) seenCasts.current.set(cast.tabId, cast);
    setStopFailed((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([ip]) => castingIps.includes(ip))),
    );
    const live = new Set(casts.map((cast) => cast.tabId));
    if (addFor !== null && !live.has(addFor)) setAddFor(null);

    const focus = pendingFocus.current;
    if (!focus) return;
    const target =
      focus.kind === 'tab'
        ? document.getElementById(TAB_CARD_ID)?.querySelector<HTMLElement>('h2')
        : document
            .getElementById(focus.tileId)
            ?.querySelector<HTMLElement>(`button[aria-label="${CSS.escape(focus.name)}"]`);
    if (target) {
      pendingFocus.current = null;
      target.focus();
    }
  }, [casts]);

  // ── Notices at their source ────────────────────────────────────────────
  const frameDrops = captureHealthAlert(isWindowsPlatform());
  const placed = placeNotices({
    connection,
    casts,
    speakers: speakerNotices.notices,
    gaps: ingestGaps.notices,
    capture:
      capture.showAlert && capture.tabId !== null
        ? { tabId: capture.tabId, key: frameDrops.key, hasAction: frameDrops.hasAction }
        : null,
    oldCompanion:
      showMismatchWarning && companion
        ? {
            appVersion: companion.appVersion,
            actionKey: versionMismatchActionKey(companion.appType),
          }
        : null,
    noReplyDismissed,
  });

  const openSettings = useCallback(() => {
    chrome.runtime.openOptionsPage();
  }, []);
  const openAudioSettings = useCallback(() => {
    const page = chrome.runtime.getManifest().options_page ?? 'src/options/index.html';
    chrome.tabs.create({ url: chrome.runtime.getURL(`${page}#audio-advanced`) });
  }, []);
  const openReleases = useCallback(() => {
    chrome.tabs.create({ url: GITHUB_RELEASES_URL });
  }, []);

  /**
   * A slot item as NoticeSlot takes it.
   * @param item - The placed item
   * @returns The item
   */
  const slotItem = (item: SlotPlan): NoticeSlotItem => ({
    id: item.id,
    tone: item.tone,
    lead: sayWords(item.lead),
    text: item.text && sayWords(item.text),
    details: item.details && {
      label: t('details'),
      content: item.details.map(sayWords).join(' '),
    },
    action: item.action && {
      label: sayWords(item.action.label),
      onClick: item.action.kind === 'open_settings' ? openSettings : openAudioSettings,
    },
    onDismiss: () => {
      if (item.source.kind === 'speaker') speakerNotices.dismiss(item.source.speakerIp);
      else if (item.source.kind === 'gaps') ingestGaps.dismiss(item.source.streamId);
      else capture.dismiss();
    },
  });

  // ── Actions ────────────────────────────────────────────────────────────

  /**
   * Adds rooms to a running cast: they show "Joining…" until it answers, and a
   * row line for each that did not join.
   * @param tabId - The cast's tab
   * @param ids - The rooms
   * @param levels - Their start levels, by room id (hand-set, or the old level for Undo)
   * @returns Resolves when the background answers, or after the join timeout
   */
  const addRooms = useCallback(
    async (tabId: number, ids: RoomId[], levels: Record<RoomId, number>): Promise<void> => {
      const adding = ids.flatMap((id) => rooms.find((room) => room.id === id) ?? []);
      if (adding.length === 0) return;
      setJoinFailed((prev) => ({
        ...prev,
        [tabId]: (prev[tabId] ?? []).filter((f) => !ids.includes(f.roomId)),
      }));
      setJoining((prev) => ({
        ...prev,
        [tabId]: [
          ...(prev[tabId] ?? []).filter((j) => !ids.includes(j.roomId)),
          ...adding.map((room) => ({
            roomId: room.id,
            name: room.name,
            level: levels[room.id] ?? joinLevel(room),
          })),
        ],
      }));
      const message: AddRoomsMessage = {
        type: 'ADD_ROOMS',
        payload: { tabId, roomIds: ids, startLevels: levels },
      };
      const answer = await Promise.race<AddRoomsResponse | null>([
        chrome.runtime.sendMessage(message).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), JOIN_TIMEOUT_MS)),
      ]);
      const joined = new Set(
        (answer?.rooms ?? []).filter((room) => room.joined).map((room) => room.roomId),
      );
      setJoining((prev) => ({
        ...prev,
        [tabId]: (prev[tabId] ?? []).filter((j) => !ids.includes(j.roomId)),
      }));
      const failed = adding.filter((room) => !joined.has(room.id));
      if (failed.length > 0) {
        setJoinFailed((prev) => ({
          ...prev,
          [tabId]: [
            ...(prev[tabId] ?? []).filter((f) => !ids.includes(f.roomId)),
            ...failed.map((room) => ({ roomId: room.id, name: room.name, dismissed: false })),
          ],
        }));
      }
    },
    [rooms, sonos.state, limit],
  );

  /**
   * The level a room joins at before the companion reads it: its start level
   * as the picker shows it, else the limit, else not known ("…").
   * @param room - The room
   * @returns The level
   */
  function joinLevel(room: Room): number | undefined {
    const now = roomLevel(room, sonos.state).now;
    if (now === undefined) return limit ?? undefined;
    return limit === null ? now : Math.min(now, limit);
  }

  const handleCast = useCallback(async (): Promise<void> => {
    setToast(null);
    setCastFailure(null);
    const roomIds = choice.choice;
    if (roomIds.length === 0) return;
    const message: StartCastMessage = {
      type: 'START_CAST',
      payload: { roomIds, startLevels: start.levelsFor(roomIds) },
    };
    try {
      const response: ExtensionResponse = await chrome.runtime.sendMessage(message);
      if (!response?.success) {
        setCastFailure(castBarFailure(response?.error, response?.errorParams ?? {}));
        return;
      }
      // Hand-set levels are for this cast only.
      start.clear(roomIds);
    } catch {
      setCastFailure(castBarFailure(undefined));
    }
  }, [choice.choice, start]);

  const handleStop = useCallback(
    async (cast: ActiveCast): Promise<void> => {
      setToast(null);
      const index = casts.findIndex((c) => c.tabId === cast.tabId);
      const next = casts[index + 1] ?? casts[index - 1];
      pendingFocus.current = next
        ? {
            kind: 'stop',
            tileId: `cast-${next.tabId}`,
            name: t('stop_cast_named', { title: castTitle(next) }),
          }
        : { kind: 'tab' };
      const stopped = await stopCast(cast.tabId).catch(() => false);
      if (!stopped) {
        // The cast still runs, so focus stays on its Stop (which shows it failed); a later
        // change must not move it.
        pendingFocus.current = null;
        throw new Error('stop_failed');
      }
      // P-stop: no Undo after Stop; the Announcer says it.
      say(t('cast_stopped', { name: roomsNameOf(cast) }));
    },
    [casts, roomsNameOf, stopCast, say, t],
  );

  /**
   * A cast's title, as its Stop names it.
   * @param cast - The cast
   * @returns The title
   */
  function castTitle(cast: ActiveCast): string {
    return cast.captureMode === 'browser' ? t('whole_browser') : getDisplayTitle(cast.mediaState);
  }

  const handleRemove = useCallback(
    (cast: ActiveCast, row: CastRow) => {
      setToast({
        text: t('room_left_cast', { name: row.name }),
        undo:
          row.roomIds.length > 0
            ? {
                tabId: cast.tabId,
                ip: row.ip,
                roomIds: row.roomIds,
                levels: undoLevels(row, rooms, sonos.state),
              }
            : undefined,
      });
      void removeSpeaker(cast.tabId, row.ip);
    },
    [rooms, sonos.state, removeSpeaker, t],
  );

  /**
   * Waits until a target has left a cast (the removal Undo undoes has landed), or the cast
   * has gone, for at most {@link UNDO_WAIT_MS}.
   * @param tabId - The cast's tab
   * @param ip - The target
   * @returns Resolves when it has left, or the wait is over
   */
  const leftCast = (tabId: number, ip: string): Promise<void> =>
    new Promise((resolve) => {
      const until = Date.now() + UNDO_WAIT_MS;
      const look = (): void => {
        const cast = castsNow.current.find((c) => c.tabId === tabId);
        if (!cast?.speakerIps.includes(ip) || Date.now() > until) resolve();
        else setTimeout(look, 100);
      };
      look();
    });

  // ── This tab ──────────────────────────────────────────────────────────
  const browserMode = captureMode === 'browser';
  const thisTabCasting = browserMode
    ? casts.some((cast) => cast.captureMode === 'browser')
    : currentTab !== null && casts.some((cast) => cast.tabId === currentTab.tabId);
  const showTabCard = !thisTabCasting && (browserMode || currentTab !== null);

  const pickRow = (room: Room, checked: boolean, onChecked: (on: boolean) => void): PickerRoom => {
    const level = roomLevel(room, sonos.state);
    const availability = roomAvailability(room, sonos.state, castingIps);
    const badge: { tone: BadgeTone; key: string } | null =
      availability === 'in_use'
        ? { tone: 'warning', key: 'speaker_availability_in_use' }
        : availability === 'casting'
          ? { tone: 'casting', key: 'speaker_availability_casting' }
          : availability === 'remote_cast'
            ? { tone: 'neutral', key: 'speaker_availability_remote_cast' }
            : null;
    return {
      room: { id: room.id, name: room.name },
      grouped:
        room.groupedWith.length > 0
          ? t('room_grouped_with', { names: list(room.groupedWith) })
          : undefined,
      badge: badge ? { tone: badge.tone, label: t(badge.key) } : undefined,
      level: { now: level.now, fixed: level.fixed, set: start.levels[room.id] },
      limit,
      checked,
      onCheckedChange: onChecked,
      startOpen: start.isOpen(room.id),
      onStartOpenChange: (open) => start.setOpen(room.id, open),
      onStartSet: (value) => start.set(room.id, value),
    };
  };

  const pickerState = placed.disconnected
    ? 'disconnected'
    : rooms.length === 0
      ? sonos.loading || !connected
        ? 'loading'
        : 'empty'
      : choice.ready
        ? 'ready'
        : 'loading';

  const plan = planCast(choice.choice, rooms);
  const playsToo = playsTooLine(plan, list);
  const hint = replaceHint(choice.chosen, sonos.state, castingIps);
  // With nothing to choose (no rooms, still asking, not connected) the picker says why.
  const castLines =
    !connected || pickerState !== 'ready'
      ? []
      : choice.choice.length === 0
        ? [t('error_no_speakers_selected')]
        : [playsToo && t(playsToo.key, playsToo.params), hint && t(hint)].filter(
            (line): line is string => Boolean(line),
          );

  const tabMedia = browserMode
    ? {
        kind: 'browser' as const,
        title: t('whole_browser'),
        subtitle: t('capture_mode_browser_enable'),
        playing: false,
      }
    : {
        kind: 'tab' as const,
        art: currentTab?.metadata?.artwork || currentTab?.tabFavicon,
        title: currentTab ? getDisplayTitle(currentTab) : '',
        subtitle: currentTab ? (getDisplaySubtitle(currentTab) ?? '') : '',
        playing: currentTab?.playbackState === 'playing',
      };

  // ── Casting now ───────────────────────────────────────────────────────
  const addCast = casts.find((cast) => cast.tabId === addFor) ?? null;

  const castVolume = (cast: ActiveCast, rows: CastRow[]) => {
    const tabId = cast.tabId;
    const playingRows: GroupVolumeRoom[] = rows.map((row) => {
      const failed = stopFailed[row.ip];
      const condition = placed.conditions[row.ip];
      return {
        room: { id: row.ip, name: row.name },
        volume: sonos.getVolume(row.ip),
        muted: sonos.getMuted(row.ip),
        fixed: sonos.getVolumeFixed(row.ip),
        onVolume: (volume) => void sonos.setVolume(row.ip, volume),
        onMute: (muted) => void sonos.setMuted(row.ip, muted),
        onRemove: () => handleRemove(cast, row),
        badge: failed
          ? { tone: 'danger', label: t('badge_still_playing') }
          : condition
            ? { tone: 'warning', label: sayWords(condition.label) }
            : undefined,
        failure:
          failed && !failed.dismissed
            ? {
                lead: t('room_still_playing', { name: row.name }),
                retry: {
                  label: t('retry_connection_not_found'),
                  onAction: () => removeSpeaker(tabId, row.ip),
                },
                onDismiss: () =>
                  setStopFailed((prev) => ({ ...prev, [row.ip]: { dismissed: true } })),
              }
            : undefined,
      };
    });
    const joiningRows: GroupVolumeRoom[] = (joining[tabId] ?? [])
      .filter((j) => {
        const room = rooms.find((r) => r.id === j.roomId);
        return !room || !cast.speakerIps.includes(room.coordinatorIp);
      })
      .map((j) => ({
        room: { id: j.roomId, name: j.name },
        muted: false,
        onVolume: () => {},
        onMute: () => {},
        joining: { level: j.level },
        badge: { tone: 'busy', label: t('badge_joining') },
      }));
    const failedRows: GroupVolumeRoom[] = (joinFailed[tabId] ?? []).flatMap((f) => {
      const room = rooms.find((r) => r.id === f.roomId);
      if (!room || cast.speakerIps.includes(room.coordinatorIp)) return [];
      const forget = () =>
        setJoinFailed((prev) => ({
          ...prev,
          [tabId]: (prev[tabId] ?? []).filter((x) => x.roomId !== f.roomId),
        }));
      return [
        {
          room: { id: f.roomId, name: f.name },
          volume: sonos.getVolume(room.coordinatorIp),
          muted: sonos.getMuted(room.coordinatorIp),
          fixed: sonos.getVolumeFixed(room.coordinatorIp),
          onVolume: (volume) => void sonos.setVolume(room.coordinatorIp, volume),
          onMute: (muted) => void sonos.setMuted(room.coordinatorIp, muted),
          onRemove: forget,
          badge: { tone: 'danger', label: t('badge_did_not_join') },
          failure: f.dismissed
            ? undefined
            : {
                lead: t('room_join_failed', { name: f.name }),
                retry: {
                  label: t('retry_connection_not_found'),
                  onAction: () => addRooms(tabId, [f.roomId], {}),
                },
                onDismiss: () =>
                  setJoinFailed((prev) => ({
                    ...prev,
                    [tabId]: (prev[tabId] ?? []).map((x) =>
                      x.roomId === f.roomId ? { ...x, dismissed: true } : x,
                    ),
                  })),
              },
        },
      ];
    });

    // Joined into one Sonos group, the joined targets move by the group's volume; every other
    // target (all of them on a cast that is not joined, or a room added to a joined one) moves
    // by the same ratio here (interim, until regrouping).
    const { joined, solo } = masterTargets(cast, rooms);
    const [coordinator] = joined;
    const master =
      rows.length > 1
        ? {
            name: rows.map((row) => row.name).join(' + '),
            onVolume: (volume: number) => {
              const parts = coordinator === undefined ? solo : [coordinator, ...solo];
              const next = scaleLevels(
                parts.map((ip) => sonos.getVolume(ip)),
                volume,
              );
              parts.forEach((ip, i) => {
                if (ip === coordinator) void sonos.setSyncGroupVolume(ip, next[i]);
                else void sonos.setVolume(ip, next[i]);
              });
            },
            onMute: (muted: boolean) => {
              if (coordinator !== undefined)
                void sonos.setSyncGroupMuted(coordinator, muted, joined);
              solo.forEach((ip) => void sonos.setMuted(ip, muted));
            },
          }
        : undefined;

    const addList: GroupVolumeAddRoom[] =
      addFor === tabId
        ? addableRooms(cast, rooms).map((room) =>
            pickRow(room, addChoice.includes(room.id), (on) =>
              setAddChoice((prev) =>
                on
                  ? [...prev.filter((id) => id !== room.id), room.id]
                  : prev.filter((id) => id !== room.id),
              ),
            ),
          )
        : [];

    return {
      rooms: [...playingRows, ...failedRows, ...joiningRows],
      master,
      expanded: foldOpen[tabId] ?? false,
      onExpandedChange: (open: boolean) => setFoldOpen((prev) => ({ ...prev, [tabId]: open })),
      add: placed.disconnected
        ? undefined
        : {
            open: addFor === tabId,
            onOpenChange: (open: boolean) => {
              setAddChoice([]);
              setAddFor(open ? tabId : null);
            },
            rooms: addList,
          },
      // The fold counts rooms, not rows: a Sonos group cast as one row is several rooms.
      strings: {
        ...words.group,
        roomsCount: () =>
          t('rooms_count', {
            count:
              rows.reduce((sum, row) => sum + Math.max(1, row.roomIds.length), 0) +
              failedRows.length +
              joiningRows.length,
          }),
      },
    };
  };

  const tiles = casts.map((cast) => {
    const rows = rowsOf(cast);
    const single = casts.length === 1;
    const open = single || (tileOpen[cast.tabId] ?? cast.tabId === currentTab?.tabId);
    const tileNotes = notes[cast.tabId] ?? [];
    return (
      <CastTileView
        key={cast.tabId}
        id={`cast-${cast.tabId}`}
        cast={cast}
        roomsName={rows.map((row) => row.name).join(' + ')}
        open={open}
        onOpenChange={
          single ? undefined : (next) => setTileOpen((prev) => ({ ...prev, [cast.tabId]: next }))
        }
        onStop={() => handleStop(cast)}
        volume={castVolume(cast, rows)}
        notices={{
          items: (placed.slots[cast.tabId] ?? []).map(slotItem),
          openLabel: (lead) => t('notice_open_cast', { lead }),
          dismissLabel: t('dismiss'),
        }}
        notes={tileNotes.map((note) => ({
          id: note.id,
          tone: 'info',
          lead: t('room_left_cast', { name: note.name }),
          details: { label: t('details'), content: t(note.key, { name: note.name }) },
          onDismiss: () =>
            setNotes((prev) => ({
              ...prev,
              [cast.tabId]: (prev[cast.tabId] ?? []).filter((n) => n.id !== note.id),
            })),
          dismissLabel: t('dismiss'),
        }))}
        words={words}
        fineTuneOpen={fineTuneOpen[cast.tabId] ?? false}
        onFineTuneChange={(next) => setFineTuneOpen((prev) => ({ ...prev, [cast.tabId]: next }))}
      />
    );
  });

  // ── The bar ───────────────────────────────────────────────────────────
  const addCount = addChoice.length;
  const castBar = addCast ? (
    <CastBar
      mode="add"
      label={t('start_casting')}
      busyLabel={t('starting')}
      onCast={async () => {}}
      disabled={addCount === 0}
      add={{
        label: addCount > 0 ? t('add_n_rooms', { count: addCount }) : t('add_room'),
        name:
          addCount > 0
            ? t('add_n_rooms_to', { count: addCount, title: castTitle(addCast) })
            : t('add_room'),
        busyLabel: t('starting'),
        cancelLabel: t('cancel'),
        onCancel: () => {
          setAddFor(null);
          setAddChoice([]);
        },
        onAdd: async () => {
          setToast(null);
          const ids = addChoice;
          const levels = start.levelsFor(ids);
          setAddFor(null);
          setAddChoice([]);
          setFoldOpen((prev) => ({ ...prev, [addCast.tabId]: true }));
          start.clear(ids);
          await addRooms(addCast.tabId, ids, levels);
        },
      }}
      dismissLabel={t('dismiss')}
    />
  ) : showTabCard ? (
    <CastBar
      mode="cast"
      label={
        choice.choice.length > 0 && !placed.disconnected
          ? t('cast_to_n_rooms', { count: choice.choice.length })
          : t('start_casting')
      }
      busyLabel={t('starting')}
      onCast={handleCast}
      lines={castLines}
      failure={
        castFailure
          ? {
              lead: sayWords(castFailure.lead),
              text: sayWords(castFailure.text),
              onDismiss: () => setCastFailure(null),
            }
          : undefined
      }
      disabled={choice.choice.length === 0 || !connected || !connection.desktopAppUrl}
      dismissLabel={t('dismiss')}
    />
  ) : null;

  const toastView = toast && (
    <Toast
      text={toast.text}
      action={
        toast.undo && {
          label: t('undo'),
          onAction: async () => {
            const undo = toast.undo;
            setToast(null);
            if (!undo) return;
            // Undo pressed before the removal lands would find the room still playing.
            await leftCast(undo.tabId, undo.ip);
            await addRooms(undo.tabId, undo.roomIds, undo.levels);
          },
        }
      }
      onDismiss={() => setToast(null)}
      dismissLabel={t('dismiss')}
    />
  );

  // ── The header and the banner ─────────────────────────────────────────
  const headerConnection: PopupConnection =
    connection.phase === 'error'
      ? 'disconnected'
      : connection.phase === 'connected'
        ? 'connected'
        : connection.phase;
  const statusText =
    connection.phase === 'checking'
      ? t('connection_status_checking')
      : connection.phase === 'reconnecting'
        ? t('reconnecting_status')
        : connection.phase === 'error'
          ? t('connection_status_disconnected')
          : connection.appType === 'desktop'
            ? t('connection_status_connected_desktop')
            : connection.appType === 'server'
              ? t('connection_status_connected_server')
              : t('connection_status_connected');

  const banner = placed.banner && (
    <Notice
      kind="banner"
      tone={placed.banner.tone}
      lead={sayWords(placed.banner.lead)}
      text={sayWords(placed.banner.text)}
      also={placed.banner.also && sayWords(placed.banner.also)}
      action={
        placed.banner.action && {
          label: sayWords(placed.banner.action.label),
          onClick: placed.banner.action.kind === 'retry' ? connection.retry : openReleases,
        }
      }
      onDismiss={placed.banner.dismissible ? dismissMismatchWarning : undefined}
      dismissLabel={t('dismiss')}
    />
  );

  const section = placed.section && (
    <Notice
      kind="section"
      tone="warning"
      lead={sayWords(placed.section.lead)}
      text={sayWords(placed.section.text)}
      onDismiss={dismissNoReply}
      dismissLabel={t('dismiss')}
    />
  );

  return (
    <PopupShell
      header={
        <PopupHeader
          name={t('app_name')}
          connection={headerConnection}
          statusText={statusText}
          description={connection.phase === 'reconnecting' ? t('warning_reconnecting') : undefined}
          live={casts.length > 0}
          onSettings={openSettings}
          settingsLabel={t('settings')}
        />
      }
      banner={banner}
      away={<AwayLine events={away.events} onDismiss={away.dismiss} words={words} />}
      bar={
        // No bar while there is nothing for it to hold (this tab casting, no Toast).
        (castBar || toastView) && <StickyActionBar toast={toastView}>{castBar}</StickyActionBar>
      }
      end={
        hasMismatch && connected ? (
          <Button kind="link" icon="external" onClick={openReleases}>
            {t('update_available')}
          </Button>
        ) : undefined
      }
    >
      {casts.length > 0 && (
        <SectionHeader
          kind="live"
          level={2}
          title={t('active_casts')}
          actions={
            placed.headingBadge && <Badge tone="warning" label={sayWords(placed.headingBadge)} />
          }
        />
      )}
      {section}
      {tiles}
      {showTabCard && (
        <TabCard
          id={TAB_CARD_ID}
          media={{ ...tabMedia, strings: words.media }}
          picker={{
            rooms: rooms.map((room) =>
              pickRow(room, choice.choice.includes(room.id), (on) => choice.toggle(room.id, on)),
            ),
            sets: choice.sets.map((set) => ({
              id: set.id,
              name:
                set.kind === 'last'
                  ? t('last_cast')
                  : set.kind === 'everywhere'
                    ? t('everywhere')
                    : (set.name ?? ''),
              kind: set.kind,
              trail:
                set.kind === 'saved'
                  ? t('saved_set')
                  : t('rooms_count', { count: set.present.length }),
              pressed: set.pressed,
              description:
                set.missing.length > 0
                  ? t('set_partial', {
                      name: list(set.missing.map((ref) => ref.name)),
                      rest: list(set.present.map((room) => room.name)),
                    })
                  : undefined,
            })),
            onSet: choice.chooseSet,
            foldOpen: pickerFold,
            onFoldChange: setPickerFold,
            query,
            onQuery: setQuery,
            save: {
              ...choice.save,
              error: choice.save.error ? t(choice.save.error) : undefined,
            },
            state: pickerState,
            strings: words.picker,
          }}
        />
      )}
    </PopupShell>
  );
}
