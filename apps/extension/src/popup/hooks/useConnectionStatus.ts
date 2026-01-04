import { useState, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { discoverDesktopApp } from '../../lib/discovery';
import type { ConnectionState } from '../../background/connection-state';

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
        // 1. Get cached state from background
        const cached: ConnectionState = await chrome.runtime.sendMessage({
          type: 'GET_CONNECTION_STATUS',
        });

        if (!mounted) return;

        // If we have a cached URL, show cached state immediately
        if (cached.desktopAppUrl) {
          // Show cached state (instant display)
          setStatus({
            connected: cached.connected,
            checking: false,
            error: cached.lastError,
            desktopAppUrl: cached.desktopAppUrl,
            maxStreams: cached.maxStreams,
            networkHealth: cached.networkHealth ?? 'ok',
            networkHealthReason: cached.networkHealthReason ?? null,
          });

          // Always attempt connection to verify/establish connection.
          // If already connected, this ensures offscreen is alive.
          // If not connected, this attempts reconnection.
          // The message listener will update state based on result.
          try {
            await chrome.runtime.sendMessage({
              type: 'WS_CONNECT',
              url: cached.desktopAppUrl,
              maxStreams: cached.maxStreams,
            });
          } catch {
            // Connection attempt failed - message listener will handle state update
          }
        } else {
          // First time - need to discover
          // Keep checking: true during discovery and connection
          const app = await discoverDesktopApp();

          if (!mounted) return;

          if (!app) {
            setStatus({
              connected: false,
              checking: false,
              error: t('error_desktop_not_found'),
              desktopAppUrl: null,
              maxStreams: null,
              networkHealth: 'ok',
              networkHealthReason: null,
            });
            return;
          }

          // Found app - store URL but keep checking: true until connected
          setStatus((s) => ({
            ...s,
            desktopAppUrl: app.url,
            maxStreams: app.maxStreams,
            // Keep checking: true - we're still connecting
          }));

          // Connect WebSocket - message listener will update state on result
          try {
            await chrome.runtime.sendMessage({
              type: 'WS_CONNECT',
              url: app.url,
              maxStreams: app.maxStreams,
            });
          } catch {
            // Connection attempt failed - message listener will handle state update
          }
        }
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
