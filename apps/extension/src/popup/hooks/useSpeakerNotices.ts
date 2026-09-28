/**
 * Speaker notices hook.
 *
 * Reads the cached per-speaker health snapshot from the background on mount
 * and replaces it on every `SPEAKER_HEALTH_CHANGED` broadcast. Exposes one
 * notice per speaker in an active cast for which the companion currently
 * stands a notice, worded for the connected companion. Nothing is judged
 * here: the companion decides whether there is a notice at all.
 *
 * Dismissal follows `lib/speaker-notices`: by `(streamId, speakerIp,
 * noticeId)`, which holds through the companion's repeats every 30 s, plus a
 * 24-hour memory of dismissed head-start advice per speaker. Both are kept in
 * `chrome.storage.local`.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { ActiveCast, AppType, CompanionAudio, SpeakerNotice } from '@thaumic-cast/protocol';
import type { SpeakerHealthEntry } from '../../lib/message-schemas';
import type { SpeakerGroupCollection } from '../../domain/speaker';
import {
  dismissNotice,
  emptyDismissals,
  isNoticeDismissed,
  parseDismissals,
  speakerNoticeLines,
  type NoticeLine,
  type SpeakerNoticeDismissals,
} from '../../lib/speaker-notices';
import { useChromeMessage } from './useChromeMessage';
import { useMountedRef } from './useMountedRef';

/** One speaker notice the popup should show. */
export interface SpeakerNoticeView {
  /** The speaker's IP, used as the notice's identity. */
  speakerIp: string;
  /** The companion's notice. */
  notice: SpeakerNotice;
  /** The sentences to translate and join, in order. */
  lines: NoticeLine[];
}

/** What {@link useSpeakerNotices} returns. */
export interface UseSpeakerNoticesResult {
  /** Notices the popup should currently render, one per affected speaker. */
  notices: SpeakerNoticeView[];
  /** Dismisses the current notice for a speaker. */
  dismiss: (speakerIp: string) => void;
}

/** What the notice wording needs from the connection. */
export interface SpeakerNoticeCompanion {
  /** The companion's speaker-side settings; null when it does not report them. */
  companionAudio: CompanionAudio | null;
  /** Which companion is connected; null when unknown. */
  appType: AppType | null;
}

type SpeakerHealthSnapshot = Record<string, SpeakerHealthEntry>;

const DISMISSED_STORAGE_KEY = 'dismissedSpeakerNotices';

/**
 * Resolves a display name for a casting speaker: the live Sonos group or
 * room name when the topology knows the IP, else the name the cast was
 * started with, else the IP itself.
 * @param speakerIp - The speaker to name
 * @param speakerGroups - Current Sonos topology
 * @param casts - Active casts, whose names are parallel to their IPs
 * @returns The best available display name
 */
export function resolveSpeakerName(
  speakerIp: string,
  speakerGroups: SpeakerGroupCollection,
  casts: ActiveCast[],
): string {
  const group = speakerGroups.findGroupContainingSpeaker(speakerIp);
  if (group) {
    return group.isCoordinator(speakerIp)
      ? group.name
      : (group.findMember(speakerIp)?.name ?? group.name);
  }
  for (const cast of casts) {
    const index = cast.speakerIps.indexOf(speakerIp);
    if (index !== -1 && cast.speakerNames[index]) return cast.speakerNames[index];
  }
  return speakerIp;
}

/**
 * Tracks the companion's speaker notices and exposes the undismissed ones for
 * the speakers of the active casts.
 * @param casts - Active casts; only their speakers can produce notices
 * @param speakerGroups - Current Sonos topology, used to name speakers
 * @param companion - The connection facts the wording depends on
 * @returns Notices to render and a per-speaker dismiss callback
 */
export function useSpeakerNotices(
  casts: ActiveCast[],
  speakerGroups: SpeakerGroupCollection,
  companion: SpeakerNoticeCompanion,
): UseSpeakerNoticesResult {
  const [snapshot, setSnapshot] = useState<SpeakerHealthSnapshot>({});
  const [dismissals, setDismissals] = useState<SpeakerNoticeDismissals>(emptyDismissals);
  const [dismissedLoaded, setDismissedLoaded] = useState(false);
  const mountedRef = useMountedRef();
  // If a broadcast lands before the initial GET resolves, the stale GET
  // response must not overwrite the newer broadcast state.
  const broadcastReceivedRef = useRef(false);

  useEffect(() => {
    chrome.runtime
      .sendMessage({ type: 'GET_SPEAKER_HEALTH' })
      .then((result: SpeakerHealthSnapshot | undefined) => {
        if (!mountedRef.current || !result) return;
        if (broadcastReceivedRef.current) return;
        setSnapshot(result);
      })
      .catch(() => {
        /* background not ready yet — broadcast will fill in when it arrives */
      });

    chrome.storage.local
      .get(DISMISSED_STORAGE_KEY)
      .then((result) => {
        if (!mountedRef.current) return;
        setDismissals(parseDismissals(result[DISMISSED_STORAGE_KEY]));
      })
      .catch(() => {
        /* storage unavailable — treat as no dismissal */
      })
      .finally(() => {
        if (mountedRef.current) setDismissedLoaded(true);
      });
  }, []);

  useChromeMessage((message) => {
    const msg = message as { type: string; speakers?: SpeakerHealthSnapshot };
    if (msg.type !== 'SPEAKER_HEALTH_CHANGED') return;
    broadcastReceivedRef.current = true;
    setSnapshot(msg.speakers ?? {});
  });

  const dismiss = useCallback(
    (speakerIp: string) => {
      const reading = snapshot[speakerIp];
      if (!reading?.notice) return;
      const next = dismissNotice(
        dismissals,
        reading.streamId,
        speakerIp,
        reading.notice,
        Date.now(),
      );
      setDismissals(next);
      chrome.storage.local.set({ [DISMISSED_STORAGE_KEY]: next }).catch(() => {
        /* best-effort; in-memory state still hides the notice this session */
      });
    },
    [snapshot, dismissals],
  );

  // Suppress until the dismissals have loaded, otherwise a previously
  // dismissed notice would flash on every popup open.
  const notices: SpeakerNoticeView[] = [];
  if (dismissedLoaded) {
    const now = Date.now();
    for (const cast of casts) {
      for (const speakerIp of cast.speakerIps) {
        const reading = snapshot[speakerIp];
        const notice = reading?.notice;
        if (!reading || !notice) continue;
        if (isNoticeDismissed(dismissals, reading.streamId, speakerIp, notice, now)) continue;
        if (notices.some((view) => view.speakerIp === speakerIp)) continue;
        notices.push({
          speakerIp,
          notice,
          lines: speakerNoticeLines(notice, {
            speakerName: resolveSpeakerName(speakerIp, speakerGroups, casts),
            companionAudio: companion.companionAudio,
            appType: companion.appType,
          }),
        });
      }
    }
  }

  return { notices, dismiss };
}
