import { useState, useEffect, useCallback } from 'preact/hooks';
import type { SonosStateSnapshot, ZoneGroup, TransportState } from '@thaumic-cast/protocol';
import { createEmptySonosState } from '@thaumic-cast/protocol';
import type {
  SonosStateResponse,
  WsStateChangedMessage,
  VolumeUpdateMessage,
  MuteUpdateMessage,
  TransportStateUpdateMessage,
} from '../../lib/messages';

/**
 * Result of the useSonosState hook.
 */
interface SonosStateResult {
  /** The current Sonos state */
  state: SonosStateSnapshot;
  /** Zone groups from state */
  groups: ZoneGroup[];
  /** Whether initial data is loading */
  loading: boolean;
  /** Get volume for a speaker */
  getVolume: (speakerIp: string) => number;
  /** Get mute state for a speaker */
  getMuted: (speakerIp: string) => boolean;
  /** Get transport state for a speaker */
  getTransportState: (speakerIp: string) => TransportState | undefined;
  /** Set volume for a speaker */
  setVolume: (speakerIp: string, volume: number) => Promise<void>;
  /** Set mute state for a speaker */
  setMuted: (speakerIp: string, muted: boolean) => Promise<void>;
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
    // Initial fetch
    chrome.runtime
      .sendMessage({ type: 'GET_SONOS_STATE' })
      .then((response: SonosStateResponse) => {
        if (response.state) {
          setState(response.state);
        }
      })
      .catch(() => {
        // Background might not be ready
      })
      .finally(() => setLoading(false));

    // Listen for updates
    const handler = (message: unknown) => {
      const msg = message as { type: string };
      switch (msg.type) {
        case 'WS_STATE_CHANGED': {
          const { state: newState } = message as WsStateChangedMessage;
          setState(newState);
          break;
        }
        case 'VOLUME_UPDATE': {
          const { speakerIp, volume } = message as VolumeUpdateMessage;
          setState((prev) => ({
            ...prev,
            groupVolumes: { ...prev.groupVolumes, [speakerIp]: volume },
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
    };

    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  const getVolume = useCallback(
    (speakerIp: string): number => state.groupVolumes[speakerIp] ?? 50,
    [state.groupVolumes],
  );

  const getMuted = useCallback(
    (speakerIp: string): boolean => state.groupMutes[speakerIp] ?? false,
    [state.groupMutes],
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

  return {
    state,
    groups: state.groups,
    loading,
    getVolume,
    getMuted,
    getTransportState,
    setVolume,
    setMuted,
  };
}
