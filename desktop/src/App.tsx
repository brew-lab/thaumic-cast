import { useState, useEffect } from 'preact/hooks';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { StatusPanel } from './components/StatusPanel';
import type { Status, SonosStateSnapshot } from './types';

interface StreamsChangedPayload {
  active_streams: number;
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [sonosState, setSonosState] = useState<SonosStateSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch server status once on mount (static fields: ports, IP, etc.)
  useEffect(() => {
    invoke<Status>('get_status')
      .then((result) => {
        setStatus(result);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  // Listen for streams-changed event (updates active_streams count)
  useEffect(() => {
    const unlisten = listen<StreamsChangedPayload>('streams-changed', (event) => {
      setStatus((prev) =>
        prev ? { ...prev, active_streams: event.payload.active_streams } : prev
      );
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Sonos state is event-driven (no polling needed)
  useEffect(() => {
    // Initial fetch
    invoke<SonosStateSnapshot>('get_sonos_state')
      .then(setSonosState)
      .catch((e) => console.error('Failed to get Sonos state:', e));

    // Listen for state changes
    const unlisten = listen<SonosStateSnapshot>('sonos-state-changed', (event) => {
      setSonosState(event.payload);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Thaumic Cast</h1>
      <p style={styles.subtitle}>Desktop Companion</p>

      {error && <div style={styles.error}>{error}</div>}

      {status ? (
        <StatusPanel status={status} sonosState={sonosState} />
      ) : (
        <div style={styles.loading}>Loading...</div>
      )}
    </div>
  );
}

const styles: Record<string, preact.CSSProperties> = {
  container: {
    maxWidth: '100%',
  },
  title: {
    fontSize: '1.5rem',
    fontWeight: 600,
    marginBottom: '4px',
    color: '#fff',
  },
  subtitle: {
    fontSize: '0.875rem',
    color: '#888',
    marginBottom: '20px',
  },
  error: {
    background: '#ff4444',
    color: '#fff',
    padding: '10px',
    borderRadius: '6px',
    marginBottom: '16px',
    fontSize: '0.875rem',
  },
  loading: {
    color: '#888',
    fontSize: '0.875rem',
  },
};
