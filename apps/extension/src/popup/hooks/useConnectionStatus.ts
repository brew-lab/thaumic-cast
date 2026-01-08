import { useState, useEffect, useRef } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { ConnectionState } from '../../background/connection-state';
import type { EnsureConnectionResponse } from '../../lib/messages';
import { useChromeMessage } from './useChromeMessage';

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
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    /** Initializes connection status from background state. */
    async function init() {
      try {
        const cached: ConnectionState = await chrome.runtime.sendMessage({
          type: 'GET_CONNECTION_STATUS',
        });

        if (!mountedRef.current) return;

        if (cached.desktopAppUrl) {
          setStatus({
            connected: cached.connected,
            checking: !cached.connected,
            error: cached.lastError ? t(cached.lastError) : null,
            desktopAppUrl: cached.desktopAppUrl,
            maxStreams: cached.maxStreams,
            networkHealth: cached.networkHealth ?? 'ok',
            networkHealthReason: cached.networkHealthReason ?? null,
          });
        }

        const response: EnsureConnectionResponse = await chrome.runtime.sendMessage({
          type: 'ENSURE_CONNECTION',
        });

        if (!mountedRef.current) return;

        setStatus((s) => ({
          ...s,
          checking: !response.connected && !response.error,
          error: response.error ? t(response.error) : null,
          desktopAppUrl: response.desktopAppUrl ?? s.desktopAppUrl,
          maxStreams: response.maxStreams ?? s.maxStreams,
        }));
      } catch (err) {
        if (!mountedRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        setStatus((s) => ({
          ...s,
          checking: false,
          error: message,
        }));
      }
    }

    init();

    return () => {
      mountedRef.current = false;
    };
  }, []);

  useChromeMessage((message) => {
    const msg = message as { type: string; [key: string]: unknown };
    switch (msg.type) {
      case 'WS_STATE_CHANGED':
        setStatus((s) => ({
          ...s,
          connected: true,
          checking: false,
          error: null,
        }));
        break;

      case 'WS_CONNECTION_LOST': {
        const reason = msg.reason as string;
        setStatus((s) => ({
          ...s,
          connected: false,
          checking: false,
          error: reason === 'max_retries_exceeded' ? t('error_connection_lost') : null,
        }));
        break;
      }

      case 'NETWORK_HEALTH_CHANGED': {
        const health = msg.health as NetworkHealthStatus;
        const reason = msg.reason as string | null;
        setStatus((s) => ({
          ...s,
          networkHealth: health,
          networkHealthReason: reason,
        }));
        break;
      }
    }
  });

  return status;
}
