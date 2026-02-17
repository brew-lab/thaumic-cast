import { useReducer, useEffect, useCallback } from 'preact/hooks';
import type { ConnectionState as BackgroundConnectionState } from '../../background/connection-state';
import type { EnsureConnectionResponse } from '../../lib/messages';
import { useChromeMessage } from './useChromeMessage';
import { useMountedRef } from './useMountedRef';

/** Network health status from desktop app */
export type NetworkHealthStatus = 'ok' | 'degraded';

/**
 * Connection phase representing the current state of desktop app connection.
 * - `checking`: Initial connection attempt or user-triggered retry in progress
 * - `reconnecting`: Had connection, lost it, auto-reconnect in progress
 * - `connected`: Successfully connected to desktop app
 * - `error`: Connection failed, user action may be needed
 */
export type ConnectionPhase = 'checking' | 'reconnecting' | 'connected' | 'error';

/**
 * Connection status for the popup.
 */
export interface ConnectionStatus {
  /** Current connection phase */
  phase: ConnectionPhase;
  /** Error key or message (only set when phase === 'error'). Use with t(error, { defaultValue: error }) */
  error: string | null;
  /** Whether manual retry is available (only relevant when phase === 'error') */
  canRetry: boolean;
  /** Desktop app URL if discovered */
  desktopAppUrl: string | null;
  /** Maximum concurrent streams allowed */
  maxStreams: number | null;
  /** Network health status from desktop (speakers responding, etc.) */
  networkHealth: NetworkHealthStatus;
  /** Reason for degraded network health (null if healthy) */
  networkHealthReason: string | null;
  /** Triggers a connection retry attempt (sets phase to 'checking') */
  retry: () => Promise<void>;
}

/** Internal state managed by the reducer */
interface ConnectionState {
  phase: ConnectionPhase;
  error: string | null;
  canRetry: boolean;
  desktopAppUrl: string | null;
  maxStreams: number | null;
  networkHealth: NetworkHealthStatus;
  networkHealthReason: string | null;
}

/** Actions that can update connection state */
type ConnectionAction =
  | { type: 'RETRY_STARTED' }
  | { type: 'CACHED_STATE_RECEIVED'; payload: BackgroundConnectionState }
  | { type: 'CONNECTION_RESPONSE'; payload: EnsureConnectionResponse }
  | { type: 'RUNTIME_ERROR'; error: string }
  | { type: 'WS_CONNECTED' }
  | { type: 'WS_RECONNECTING' }
  | { type: 'WS_PERMANENTLY_LOST' }
  | { type: 'CONNECTION_FAILED'; error: string; canRetry: boolean }
  | { type: 'NETWORK_HEALTH_CHANGED'; health: NetworkHealthStatus; reason: string | null };

const initialState: ConnectionState = {
  phase: 'checking',
  error: null,
  canRetry: false,
  desktopAppUrl: null,
  maxStreams: null,
  networkHealth: 'ok',
  networkHealthReason: null,
};

/**
 * Derives connection phase from connection flags.
 * @param connected - Whether the connection is established
 * @param hasError - Whether an error has occurred
 * @returns The current connection phase
 */
function derivePhase(connected: boolean, hasError: boolean): ConnectionPhase {
  if (connected) return 'connected';
  if (hasError) return 'error';
  return 'checking';
}

/**
 * Reducer for connection state transitions.
 * Centralizes all state update logic for easier testing and reasoning.
 * @param state - Current connection state
 * @param action - The dispatched action
 * @returns Updated connection state
 */
function connectionReducer(state: ConnectionState, action: ConnectionAction): ConnectionState {
  switch (action.type) {
    case 'RETRY_STARTED':
      return { ...state, phase: 'checking', error: null, canRetry: false };

    case 'CACHED_STATE_RECEIVED': {
      const {
        connected,
        lastError,
        desktopAppUrl,
        maxStreams,
        networkHealth,
        networkHealthReason,
      } = action.payload;
      if (!desktopAppUrl) return state;
      return {
        ...state,
        phase: derivePhase(connected, !!lastError),
        error: lastError ?? null,
        canRetry: !!lastError,
        desktopAppUrl,
        maxStreams,
        networkHealth: networkHealth ?? 'ok',
        networkHealthReason: networkHealthReason ?? null,
      };
    }

    case 'CONNECTION_RESPONSE': {
      const { connected, error, desktopAppUrl, maxStreams } = action.payload;
      return {
        ...state,
        phase: derivePhase(connected, !!error),
        error: error ?? null,
        canRetry: !!error,
        desktopAppUrl: desktopAppUrl ?? state.desktopAppUrl,
        maxStreams: maxStreams ?? state.maxStreams,
      };
    }

    case 'RUNTIME_ERROR':
      return { ...state, phase: 'error', error: action.error, canRetry: false };

    case 'WS_CONNECTED':
      return { ...state, phase: 'connected', error: null, canRetry: false };

    case 'WS_RECONNECTING':
      return { ...state, phase: 'reconnecting', error: null, canRetry: false };

    case 'WS_PERMANENTLY_LOST':
      return { ...state, phase: 'error', error: 'error_connection_lost', canRetry: true };

    case 'CONNECTION_FAILED':
      return { ...state, phase: 'error', error: action.error, canRetry: action.canRetry };

    case 'NETWORK_HEALTH_CHANGED':
      return { ...state, networkHealth: action.health, networkHealthReason: action.reason };

    default:
      return state;
  }
}

/**
 * Hook for connection status with instant cached display.
 *
 * Uses cached connection state from background for instant UI rendering,
 * only showing "Checking..." on first-ever connection.
 *
 * @returns Current connection status including retry function
 */
export function useConnectionStatus(): ConnectionStatus {
  const [state, dispatch] = useReducer(connectionReducer, initialState);
  const mountedRef = useMountedRef();

  /** Triggers a connection retry attempt. */
  const retry = useCallback(async () => {
    dispatch({ type: 'RETRY_STARTED' });
    try {
      await chrome.runtime.sendMessage({ type: 'ENSURE_CONNECTION' });
      // State will be updated by broadcast messages (WS_STATE_CHANGED, CONNECTION_ATTEMPT_FAILED, etc.)
    } catch (err) {
      if (!mountedRef.current) return;
      const error = err instanceof Error ? err.message : String(err);
      dispatch({ type: 'RUNTIME_ERROR', error });
    }
  }, [mountedRef]);

  // Initialize connection on mount
  useEffect(() => {
    /** Initializes connection by fetching cached state and setting up listeners. */
    async function init() {
      try {
        // Fetch cached state for instant display
        const cached: BackgroundConnectionState = await chrome.runtime.sendMessage({
          type: 'GET_CONNECTION_STATUS',
        });
        if (!mountedRef.current) return;
        dispatch({ type: 'CACHED_STATE_RECEIVED', payload: cached });

        // Trigger connection if needed
        const response: EnsureConnectionResponse = await chrome.runtime.sendMessage({
          type: 'ENSURE_CONNECTION',
        });
        if (!mountedRef.current) return;
        dispatch({ type: 'CONNECTION_RESPONSE', payload: response });
      } catch (err) {
        if (!mountedRef.current) return;
        const error = err instanceof Error ? err.message : String(err);
        dispatch({ type: 'RUNTIME_ERROR', error });
      }
    }

    init();
  }, []);

  // Listen for connection-related broadcast messages
  useChromeMessage((message) => {
    const msg = message as { type: string; [key: string]: unknown };
    switch (msg.type) {
      case 'WS_STATE_CHANGED':
        dispatch({ type: 'WS_CONNECTED' });
        // Fetch connection metadata in case ENSURE_CONNECTION response hasn't arrived yet
        // (race condition: WS connects before response is processed)
        chrome.runtime
          .sendMessage({ type: 'GET_CONNECTION_STATUS' })
          .then((status: BackgroundConnectionState) => {
            if (mountedRef.current && status.desktopAppUrl) {
              dispatch({ type: 'CACHED_STATE_RECEIVED', payload: status });
            }
          })
          .catch(() => {});
        break;

      case 'WS_CONNECTION_LOST': {
        const reason = msg.reason as string;
        if (reason === 'max_retries_exceeded') {
          dispatch({ type: 'WS_PERMANENTLY_LOST' });
        } else {
          dispatch({ type: 'WS_RECONNECTING' });
        }
        break;
      }

      case 'CONNECTION_ATTEMPT_FAILED':
        dispatch({
          type: 'CONNECTION_FAILED',
          error: msg.error as string,
          canRetry: msg.canRetry as boolean,
        });
        break;

      case 'NETWORK_HEALTH_CHANGED':
        dispatch({
          type: 'NETWORK_HEALTH_CHANGED',
          health: msg.health as NetworkHealthStatus,
          reason: msg.reason as string | null,
        });
        break;
    }
  });

  return { ...state, retry };
}
