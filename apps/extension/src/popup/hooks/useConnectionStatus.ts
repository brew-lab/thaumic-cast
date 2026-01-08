import { useState, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { ConnectionState } from '../../background/connection-state';
import type { EnsureConnectionResponse } from '../../lib/messages';

/** Network health status from desktop app */
export type NetworkHealthStatus = 'ok' | 'degraded';

/**
 * Connection status for the popup.
 */
export interface ConnectionStatus {
  /** Whether WebSocket is currently connected */
  connected: boolean;
  /** Whether we're actively checking connection (only on first load) */
  checking: boolean;
  /** Error message if any */
  error: string | null;
  /** Desktop app URL if discovered */
  desktopAppUrl: string | null;
  /** Maximum concurrent streams allowed */
  maxStreams: number | null;
  /** Network health status from desktop (speakers responding, etc.) */
  networkHealth: NetworkHealthStatus;
  /** Reason for degraded network health (null if healthy) */
  networkHealthReason: string | null;
}

/**
 * Hook for connection status with instant cached display.
 *
 * Uses cached connection state from background for instant UI rendering,
 * only showing "Checking..." on first-ever connection.
 *
 * @returns Current connection status
 */
export function useConnectionStatus(): ConnectionStatus {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ConnectionStatus>({
    connected: false,
    checking: true,
    error: null,
    desktopAppUrl: null,
    maxStreams: null,
    networkHealth: 'ok',
    networkHealthReason: null,
  });

  useEffect(() => {
    let mounted = true;

    /**
     * Initializes the connection status by checking the background state.
     */
    async function init() {
      try {
        // 1. Get cached state from background for instant display
        const cached: ConnectionState = await chrome.runtime.sendMessage({
          type: 'GET_CONNECTION_STATUS',
        });

        if (!mounted) return;

        // Show cached state immediately (instant display)
        if (cached.desktopAppUrl) {
          setStatus({
            connected: cached.connected,
            checking: !cached.connected, // Still checking if not connected
            error: cached.lastError,
            desktopAppUrl: cached.desktopAppUrl,
            maxStreams: cached.maxStreams,
            networkHealth: cached.networkHealth ?? 'ok',
            networkHealthReason: cached.networkHealthReason ?? null,
          });
        }

        // 2. Request background to ensure connection (discovers if needed)
        const response: EnsureConnectionResponse = await chrome.runtime.sendMessage({
          type: 'ENSURE_CONNECTION',
        });

        if (!mounted) return;

        // Update with response - connection may still be in progress
        setStatus((s) => ({
          ...s,
          checking: !response.connected && !response.error,
          error: response.error,
          desktopAppUrl: response.desktopAppUrl ?? s.desktopAppUrl,
          maxStreams: response.maxStreams ?? s.maxStreams,
        }));
      } catch (err) {
        if (!mounted) return;
        const message = err instanceof Error ? err.message : String(err);
        setStatus((s) => ({
          ...s,
          checking: false,
          error: message,
        }));
      }
    }

    init();

    // Listen for connection state changes from background
    const handler = (message: { type: string; [key: string]: unknown }) => {
      switch (message.type) {
        case 'WS_STATE_CHANGED':
          setStatus((s) => ({
            ...s,
            connected: true,
            checking: false,
            error: null,
          }));
          break;

        case 'WS_CONNECTION_LOST': {
          const reason = message.reason as string;
          setStatus((s) => ({
            ...s,
            connected: false,
            checking: false,
            error: reason === 'max_retries_exceeded' ? t('error_connection_lost') : null,
          }));
          break;
        }

        case 'NETWORK_HEALTH_CHANGED': {
          const health = message.health as NetworkHealthStatus;
          const reason = message.reason as string | null;
          setStatus((s) => ({
            ...s,
            networkHealth: health,
            networkHealthReason: reason,
          }));
          break;
        }
      }
    };

    chrome.runtime.onMessage.addListener(handler);

    return () => {
      mounted = false;
      chrome.runtime.onMessage.removeListener(handler);
    };
  }, []);

  return status;
}
