/**
 * Speaker health hook.
 *
 * Mirrors `useSpeakerLinkQuality`. Reads the cached per-speaker snapshot from
 * the background on mount and replaces it on every `SPEAKER_HEALTH_CHANGED`
 * broadcast. Exposes one alert per speaker in an active cast whose buffer the
 * companion currently rates `low` or `draining`.
 *
 * Dismissal is keyed on the reading's `alarmSince` per speaker and persisted
 * in `chrome.storage.local`. The companion repeats the reading every 30 s,
 * but `alarmSince` holds while the speaker stays low or draining, so a
 * dismissed alert stays hidden until the speaker recovers and runs low again.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { ActiveCast } from '@thaumic-cast/protocol';
import type { SpeakerHealthEntry } from '../../lib/message-schemas';
import type { SpeakerGroupCollection } from '../../domain/speaker';
import { useChromeMessage } from './useChromeMessage';
import { useMountedRef } from './useMountedRef';
import { isDismissedMap, resolveSpeakerName } from './useSpeakerLinkQuality';

/** One speaker whose buffer warrants an alert. */
export interface SpeakerHealthAlert {
  /** The speaker's IP, used as the alert's identity. */
  speakerIp: string;
  /** Room or group name to show, falling back to the IP. */
  speakerName: string;
  /** The companion's verdict; only the alarm states reach here. */
  state: 'low' | 'draining';
  /** Minutes until the buffer runs dry, when the companion projects it. */
  minutesToEmpty?: number;
}

/** What {@link useSpeakerHealth} returns. */
export interface UseSpeakerHealthResult {
  /** Alerts the popup should currently render, one per affected speaker. */
  alerts: SpeakerHealthAlert[];
  /** Dismisses the current low run for a speaker — re-armed by the next one. */
  dismiss: (speakerIp: string) => void;
}

type SpeakerHealthSnapshot = Record<string, SpeakerHealthEntry>;
type DismissedMap = Record<string, number>;

const DISMISSED_STORAGE_KEY = 'dismissedSpeakerHealthAt';

/**
 * Tracks per-speaker buffer health and exposes dismissible alerts for the
 * speakers of the active casts.
 * @param casts - Active casts; only their speakers can produce alerts
 * @param speakerGroups - Current Sonos topology, used to name speakers
 * @returns Alerts to render and a per-speaker dismiss callback
 */
export function useSpeakerHealth(
  casts: ActiveCast[],
  speakerGroups: SpeakerGroupCollection,
): UseSpeakerHealthResult {
  const [snapshot, setSnapshot] = useState<SpeakerHealthSnapshot>({});
  const [dismissed, setDismissed] = useState<DismissedMap>({});
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
    const msg = message as { type: string; speakers?: SpeakerHealthSnapshot };
    if (msg.type !== 'SPEAKER_HEALTH_CHANGED') return;
    broadcastReceivedRef.current = true;
    setSnapshot(msg.speakers ?? {});
  });

  const dismiss = useCallback(
    (speakerIp: string) => {
      const since = snapshot[speakerIp]?.alarmSince;
      if (since === undefined) return;
      const next = { ...dismissed, [speakerIp]: since };
      setDismissed(next);
      chrome.storage.local.set({ [DISMISSED_STORAGE_KEY]: next }).catch(() => {
        /* best-effort; in-memory state still hides the alert this session */
      });
    },
    [snapshot, dismissed],
  );

  // Suppress until the dismissals have loaded, otherwise a previously
  // dismissed reading would flash the alert on every popup open.
  const alerts: SpeakerHealthAlert[] = [];
  if (dismissedLoaded) {
    for (const cast of casts) {
      for (const speakerIp of cast.speakerIps) {
        const reading = snapshot[speakerIp];
        if (!reading || reading.alarmSince === undefined) continue;
        if (reading.state !== 'low' && reading.state !== 'draining') continue;
        if (dismissed[speakerIp] === reading.alarmSince) continue;
        if (alerts.some((alert) => alert.speakerIp === speakerIp)) continue;
        alerts.push({
          speakerIp,
          speakerName: resolveSpeakerName(speakerIp, speakerGroups, casts),
          state: reading.state,
          minutesToEmpty:
            reading.timeToEmptyS !== undefined
              ? Math.max(1, Math.round(reading.timeToEmptyS / 60))
              : undefined,
        });
      }
    }
  }

  return { alerts, dismiss };
}
