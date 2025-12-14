import { useState, useEffect } from 'preact/hooks';
import { invoke } from '@tauri-apps/api/core';
import { StatusPanel } from './components/StatusPanel';
import type { Status } from './types';

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = async () => {
    try {
      const result = await invoke<Status>('get_status');
      setStatus(result);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Thaumic Cast</h1>
      <p style={styles.subtitle}>Desktop Companion</p>

      {error && <div style={styles.error}>{error}</div>}

      {status ? (
        <StatusPanel status={status} onRefresh={fetchStatus} />
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
