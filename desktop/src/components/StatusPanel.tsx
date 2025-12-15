import { useState, useEffect } from 'preact/hooks';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import type { Status } from '../types';

interface Props {
  status: Status;
}

function formatTimestamp(unixTimestamp: number | null | undefined): string {
  if (!unixTimestamp) return 'Never';
  const date = new Date(unixTimestamp * 1000);
  return date.toLocaleTimeString();
}

export function StatusPanel({ status }: Props) {
  const [autostartEnabled, setAutostartEnabled] = useState<boolean | null>(null);
  const [autostartLoading, setAutostartLoading] = useState(false);

  useEffect(() => {
    isEnabled().then(setAutostartEnabled).catch(console.error);
  }, []);

  const toggleAutostart = async () => {
    setAutostartLoading(true);
    try {
      if (autostartEnabled) {
        await disable();
        setAutostartEnabled(false);
      } else {
        await enable();
        setAutostartEnabled(true);
      }
    } catch (e) {
      console.error('Failed to toggle autostart:', e);
    } finally {
      setAutostartLoading(false);
    }
  };

  return (
    <div style={styles.panel}>
      {/* Startup Errors */}
      {status.startup_errors && status.startup_errors.length > 0 && (
        <div style={styles.errorSection}>
          <h3 style={styles.errorTitle}>Startup Issues</h3>
          {status.startup_errors.map((error, i) => (
            <div key={i} style={styles.errorItem}>
              {error}
            </div>
          ))}
        </div>
      )}

      {/* Server Status */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Server</h3>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>Status</span>
          <span
            style={{ ...styles.statusValue, color: status.server_running ? '#4caf50' : '#f44336' }}
          >
            {status.server_running ? 'Running' : 'Stopped'}
          </span>
        </div>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>HTTP Port</span>
          <span style={styles.statusValue}>{status.port}</span>
        </div>
        {status.gena_port && (
          <div style={styles.statusRow}>
            <span style={styles.statusLabel}>GENA Port</span>
            <span style={styles.statusValue}>{status.gena_port}</span>
          </div>
        )}
        {status.local_ip && (
          <div style={styles.statusRow}>
            <span style={styles.statusLabel}>Local IP</span>
            <span style={styles.statusValue}>{status.local_ip}</span>
          </div>
        )}
      </div>

      {/* Activity */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Activity</h3>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>Active Streams</span>
          <span style={styles.statusValue}>{status.active_streams}</span>
        </div>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>GENA Subscriptions</span>
          <span style={styles.statusValue}>{status.gena_subscriptions}</span>
        </div>
      </div>

      {/* Speakers */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Speakers</h3>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>Discovered</span>
          <span style={styles.statusValue}>{status.discovered_speakers}</span>
        </div>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>Last Scan</span>
          <span style={styles.statusValue}>{formatTimestamp(status.last_discovery_at)}</span>
        </div>
        <p style={styles.hintText}>Speakers are discovered automatically every 5 minutes.</p>
      </div>

      {/* Settings */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Settings</h3>
        <div style={styles.settingsRow}>
          <div>
            <span style={styles.settingsLabel}>Start on Login</span>
            <span style={styles.settingsHint}>Launch minimized when your computer starts</span>
          </div>
          <button
            style={{
              ...styles.toggleButton,
              background: autostartEnabled ? '#4caf50' : '#333',
            }}
            onClick={toggleAutostart}
            disabled={autostartLoading || autostartEnabled === null}
          >
            {autostartLoading ? '...' : autostartEnabled ? 'On' : 'Off'}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, preact.CSSProperties> = {
  panel: {
    background: '#16213e',
    borderRadius: '8px',
    padding: '16px',
  },
  errorSection: {
    background: '#3d1a1a',
    borderRadius: '6px',
    padding: '12px',
    marginBottom: '16px',
  },
  errorTitle: {
    fontSize: '0.75rem',
    fontWeight: 600,
    color: '#f44336',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    marginBottom: '8px',
  },
  errorItem: {
    fontSize: '0.8rem',
    color: '#ff8a80',
    marginBottom: '4px',
  },
  section: {
    marginBottom: '20px',
  },
  sectionTitle: {
    fontSize: '0.75rem',
    fontWeight: 600,
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    marginBottom: '12px',
  },
  statusRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '8px 0',
    borderBottom: '1px solid #1a1a2e',
  },
  statusLabel: {
    color: '#888',
    fontSize: '0.875rem',
  },
  statusValue: {
    fontWeight: 500,
    color: '#fff',
    fontSize: '0.875rem',
  },
  hintText: {
    color: '#555',
    fontSize: '0.75rem',
    marginTop: '8px',
    fontStyle: 'italic',
  },
  settingsRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 0',
  },
  settingsLabel: {
    color: '#ccc',
    fontSize: '0.875rem',
    display: 'block',
  },
  settingsHint: {
    color: '#555',
    fontSize: '0.75rem',
    display: 'block',
    marginTop: '2px',
  },
  toggleButton: {
    border: 'none',
    padding: '6px 16px',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.75rem',
    fontWeight: 600,
    color: '#fff',
    minWidth: '50px',
  },
};
