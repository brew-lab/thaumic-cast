import { useState, useEffect, useCallback, useMemo } from 'preact/hooks';
import type { SonosStateSnapshot, TransportState } from '@thaumic-cast/protocol';
import { createEmptySonosState } from '@thaumic-cast/protocol';
import type {
  SonosStateResponse,
  WsStateChangedMessage,
  VolumeUpdateMessage,
  MuteUpdateMessage,
  TransportStateUpdateMessage,
} from '../../lib/messages';
import { SpeakerGroupCollection } from '../../domain/speaker';
import { noop } from '../../lib/noop';
import { useChromeMessage } from './useChromeMessage';

/**
 * Result of the useSonosState hook.
 */
interface SonosStateResult {
  /** The current Sonos state */
  state: SonosStateSnapshot;
  /** Speaker groups as domain model collection (sorted, type-safe) */
  speakerGroups: SpeakerGroupCollection;
  /** Whether initial data is loading */
  loading: boolean;
  /** Get volume for a speaker */
  getVolume: (speakerIp: string) => number;
  /** Get mute state for a speaker */
  getMuted: (speakerIp: string) => boolean;
  /** Get whether volume is fixed (line-level output) for a speaker */
  getVolumeFixed: (speakerIp: string) => boolean;
  /** Get transport state for a speaker */
  getTransportState: (speakerIp: string) => TransportState | undefined;
  /** Set volume for a speaker */
  setVolume: (speakerIp: string, volume: number) => Promise<void>;
  /** Set mute state for a speaker */
  setMuted: (speakerIp: string, muted: boolean) => Promise<void>;
  /** Set group volume for all speakers in a sync session */
  setSyncGroupVolume: (speakerIp: string, volume: number) => Promise<void>;
  /** Set group mute for all speakers in a sync session */
  setSyncGroupMuted: (speakerIp: string, muted: boolean, allSpeakerIps: string[]) => Promise<void>;
}

/**
 * Hook for Sonos state with real-time updates.
 * Subscribes to state changes from the background script.
 * @returns Sonos state and control functions
 */
export function useSonosState(): SonosStateResult {
  const [state, setState] = useState<SonosStateSnapshot>(createEmptySonosState());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    chrome.runtime
      .sendMessage({ type: 'GET_SONOS_STATE' })
      .then((response: SonosStateResponse) => {
        if (response.state) {
          setState(response.state);
        }
      })
      .catch(noop)
      .finally(() => setLoading(false));
  }, []);

  useChromeMessage((message) => {
    const msg = message as { type: string };
    switch (msg.type) {
      case 'WS_STATE_CHANGED': {
        const { state: newState } = message as WsStateChangedMessage;
        setState(newState);
        break;
      }
      case 'VOLUME_UPDATE': {
        const { speakerIp, volume, fixed } = message as VolumeUpdateMessage;
        setState((prev) => ({
          ...prev,
          groupVolumes: { ...prev.groupVolumes, [speakerIp]: volume },
          ...(fixed !== undefined && {
            groupVolumeFixed: { ...prev.groupVolumeFixed, [speakerIp]: fixed },
          }),
        }));
        break;
      }
      case 'MUTE_UPDATE': {
        const { speakerIp, muted } = message as MuteUpdateMessage;
        setState((prev) => ({
          ...prev,
          groupMutes: { ...prev.groupMutes, [speakerIp]: muted },
        }));
        break;
      }
      case 'TRANSPORT_STATE_UPDATE': {
        const { speakerIp, state: transport } = message as TransportStateUpdateMessage;
        setState((prev) => ({
          ...prev,
          transportStates: { ...prev.transportStates, [speakerIp]: transport },
        }));
        break;
      }
    }
  });

  const getVolume = useCallback(
    (speakerIp: string): number => state.groupVolumes[speakerIp] ?? 50,
    [state.groupVolumes],
  );

  const getMuted = useCallback(
    (speakerIp: string): boolean => state.groupMutes[speakerIp] ?? false,
    [state.groupMutes],
  );

  const getVolumeFixed = useCallback(
    (speakerIp: string): boolean => state.groupVolumeFixed[speakerIp] ?? false,
    [state.groupVolumeFixed],
  );

  const getTransportState = useCallback(
    (speakerIp: string): TransportState | undefined => state.transportStates[speakerIp],
    [state.transportStates],
  );

  const setVolume = useCallback(async (speakerIp: string, volume: number) => {
    // Optimistic update
    setState((prev) => ({
      ...prev,
      groupVolumes: { ...prev.groupVolumes, [speakerIp]: volume },
    }));
    await chrome.runtime.sendMessage({ type: 'SET_VOLUME', speakerIp, volume });
  }, []);

  const setMuted = useCallback(async (speakerIp: string, muted: boolean) => {
    // Optimistic update
    setState((prev) => ({
      ...prev,
      groupMutes: { ...prev.groupMutes, [speakerIp]: muted },
    }));
    await chrome.runtime.sendMessage({ type: 'SET_MUTE', speakerIp, muted });
  }, []);

  const setSyncGroupVolume = useCallback(async (speakerIp: string, volume: number) => {
    // No optimistic update: Sonos adjusts speakers proportionally (preserving
    // relative offsets), so we can't predict individual volumes. The group slider
    // stays responsive via VolumeControl's local drag state, and per-speaker
    // sliders update when RenderingControl GENA events arrive.
    await chrome.runtime.sendMessage({ type: 'SET_VOLUME', speakerIp, volume, group: true });
  }, []);

  const setSyncGroupMuted = useCallback(
    async (speakerIp: string, muted: boolean, allSpeakerIps: string[]) => {
      // Optimistic update: set all speakers in the cast to this mute state
      setState((prev) => {
        const updated = { ...prev.groupMutes };
        for (const ip of allSpeakerIps) {
          updated[ip] = muted;
        }
        return { ...prev, groupMutes: updated };
      });
      await chrome.runtime.sendMessage({ type: 'SET_MUTE', speakerIp, muted, group: true });
    },
    [],
  );

  // Memoize speaker groups collection for stable reference
  const speakerGroups = useMemo(
    () => SpeakerGroupCollection.fromZoneGroups(state.groups),
    [state.groups],
  );

  return {
    state,
    speakerGroups,
    loading,
    getVolume,
    getMuted,
    getVolumeFixed,
    getTransportState,
    setVolume,
    setMuted,
    setSyncGroupVolume,
    setSyncGroupMuted,
  };
}
