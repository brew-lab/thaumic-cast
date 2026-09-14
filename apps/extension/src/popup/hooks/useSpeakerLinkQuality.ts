/**
 * Speaker link-quality hook.
 *
 * Mirrors `useCaptureHealth`. Reads the cached per-speaker snapshot from the
 * background on mount and replaces it on every `SPEAKER_LINK_QUALITY_CHANGED`
 * broadcast. Exposes one alert per speaker in an active cast whose network
 * path the companion currently rates `degraded` or `poor`. The alert only
 * relays the companion's verdict and its buffer suggestion; nothing is
 * judged or computed here.
 *
 * Dismissal is keyed on the reading's `updatedAt` per speaker and persisted
 * in `chrome.storage.local`, so closing and reopening the popup keeps a
 * dismissed alert hidden. The companion only sends a reading when the
 * quality changes, and the background drops a speaker's reading when its
 * cast ends, so the next quality change or a new cast naturally re-arms.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { ActiveCast, LinkQuality } from '@thaumic-cast/protocol';
import type { SpeakerLinkQualityState } from '../../lib/message-schemas';
import type { SpeakerGroupCollection } from '../../domain/speaker';
import { useChromeMessage } from './useChromeMessage';
import { useMountedRef } from './useMountedRef';

/** One speaker whose network path warrants an alert. */
export interface SpeakerLinkQualityAlert {
  /** The speaker's IP, used as the alert's identity. */
  speakerIp: string;
  /** Room or group name to show, falling back to the IP. */
  speakerName: string;
  /** The companion's verdict; never `good` here. */
  quality: Exclude<LinkQuality, 'good'>;
  /** The jitter buffer the stream to this speaker runs with, in milliseconds. */
  jitterBufferMs: number;
  /** The buffer the companion suggests; undefined when raising it would not help. */
  suggestedJitterBufferMs?: number;
}

export interface UseSpeakerLinkQualityResult {
  /** Alerts the popup should currently render, one per affected speaker. */
  alerts: SpeakerLinkQualityAlert[];
  /** Dismisses the current reading for a speaker — re-armed by the next quality change. */
  dismiss: (speakerIp: string) => void;
}

type SpeakerLinkQualitySnapshot = Record<string, SpeakerLinkQualityState>;
type DismissedMap = Record<string, number>;

const DISMISSED_STORAGE_KEY = 'dismissedSpeakerLinkQualityAt';

/**
 * Resolves a display name for a casting speaker: the live Sonos group or
 * room name when the topology knows the IP, else the name the cast was
 * started with, else the IP itself.
 * @param speakerIp - The speaker to name
 * @param speakerGroups - Current Sonos topology
 * @param casts - Active casts, whose names are parallel to their IPs
 * @returns The best available display name
 */
function resolveSpeakerName(
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
 * Tracks per-speaker link quality and exposes dismissible alerts for the
 * speakers of the active casts.
 * @param casts - Active casts; only their speakers can produce alerts
 * @param speakerGroups - Current Sonos topology, used to name speakers
 * @returns Alerts to render and a per-speaker dismiss callback
 */
export function useSpeakerLinkQuality(
  casts: ActiveCast[],
  speakerGroups: SpeakerGroupCollection,
): UseSpeakerLinkQualityResult {
  const [snapshot, setSnapshot] = useState<SpeakerLinkQualitySnapshot>({});
  const [dismissed, setDismissed] = useState<DismissedMap>({});
  const [dismissedLoaded, setDismissedLoaded] = useState(false);
  const mountedRef = useMountedRef();
  // If a broadcast lands before the initial GET resolves, the stale GET
  // response must not overwrite the newer broadcast state.
  const broadcastReceivedRef = useRef(false);

  useEffect(() => {
    chrome.runtime
      .sendMessage({ type: 'GET_SPEAKER_LINK_QUALITY' })
      .then((result: SpeakerLinkQualitySnapshot | undefined) => {
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
        const stored = result[DISMISSED_STORAGE_KEY];
        setDismissed(isDismissedMap(stored) ? stored : {});
      })
      .catch(() => {
        /* storage unavailable — treat as no dismissal */
      })
      .finally(() => {
        if (mountedRef.current) setDismissedLoaded(true);
      });
  }, []);

  useChromeMessage((message) => {
    const msg = message as { type: string; speakers?: SpeakerLinkQualitySnapshot };
    if (msg.type !== 'SPEAKER_LINK_QUALITY_CHANGED') return;
    broadcastReceivedRef.current = true;
    setSnapshot(msg.speakers ?? {});
  });

  const dismiss = useCallback(
    (speakerIp: string) => {
      const reading = snapshot[speakerIp];
      if (!reading) return;
      const next = { ...dismissed, [speakerIp]: reading.updatedAt };
      setDismissed(next);
      chrome.storage.local.set({ [DISMISSED_STORAGE_KEY]: next }).catch(() => {
        /* best-effort; in-memory state still hides the alert this session */
      });
    },
    [snapshot, dismissed],
  );

  // Suppress until the dismissals have loaded, otherwise a previously
  // dismissed reading would flash the alert on every popup open.
  const alerts: SpeakerLinkQualityAlert[] = [];
  if (dismissedLoaded) {
    for (const cast of casts) {
      for (const speakerIp of cast.speakerIps) {
        const reading = snapshot[speakerIp];
        if (!reading || reading.quality === 'good') continue;
        if (dismissed[speakerIp] === reading.updatedAt) continue;
        if (alerts.some((alert) => alert.speakerIp === speakerIp)) continue;
        alerts.push({
          speakerIp,
          speakerName: resolveSpeakerName(speakerIp, speakerGroups, casts),
          quality: reading.quality,
          jitterBufferMs: reading.jitterBufferMs,
          suggestedJitterBufferMs: reading.suggestedJitterBufferMs,
        });
      }
    }
  }

  return { alerts, dismiss };
}

/**
 * Checks that a stored value is a map of speaker IP to dismissed timestamp.
 * @param value - The value read from storage
 * @returns True if every entry is a number
 */
function isDismissedMap(value: unknown): value is DismissedMap {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === 'number')
  );
}
