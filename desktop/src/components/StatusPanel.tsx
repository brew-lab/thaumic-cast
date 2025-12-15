import { useState, useEffect } from 'preact/hooks';
import { invoke } from '@tauri-apps/api/core';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import type { Speaker, Status } from '../types';

interface Props {
  status: Status;
}

function formatTimestamp(unixTimestamp: number | null | undefined): string {
  if (!unixTimestamp) return 'Never';
  const date = new Date(unixTimestamp * 1000);
  return date.toLocaleTimeString();
}

export function StatusPanel({ status }: Props) {
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [scanning, setScanning] = useState(false);
  const [autostartEnabled, setAutostartEnabled] = useState<boolean | null>(null);
  const [autostartLoading, setAutostartLoading] = useState(false);

  // Load cached speakers on mount
  useEffect(() => {
    invoke<Speaker[]>('get_speakers').then(setSpeakers).catch(console.error);
  }, []);

  useEffect(() => {
    isEnabled().then(setAutostartEnabled).catch(console.error);
  }, []);

  const handleScan = async () => {
    setScanning(true);
    try {
      const result = await invoke<Speaker[]>('refresh_speakers');
      setSpeakers(result);
    } catch (e) {
      console.error('Failed to scan for speakers:', e);
    } finally {
      setScanning(false);
    }
  };

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
        <div style={styles.sectionHeader}>
          <h3 style={{ ...styles.sectionTitle, marginBottom: 0 }}>Speakers</h3>
          <button style={styles.scanButton} onClick={handleScan} disabled={scanning}>
            {scanning ? 'Scanning...' : 'Scan'}
          </button>
        </div>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>Last Scan</span>
          <span style={styles.statusValue}>{formatTimestamp(status.last_discovery_at)}</span>
        </div>
        {speakers.length > 0 ? (
          <ul style={styles.speakerList}>
            {speakers.map((speaker) => (
              <li key={speaker.uuid} style={styles.speakerItem}>
                <span style={styles.speakerIp}>{speaker.ip}</span>
                <span style={styles.speakerUuid}>{speaker.uuid}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p style={styles.hintText}>No speakers discovered yet.</p>
        )}
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
  sectionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '12px',
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
  scanButton: {
    background: '#0f3460',
    color: '#fff',
    border: 'none',
    padding: '4px 12px',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.7rem',
    fontWeight: 500,
  },
  speakerList: {
    listStyle: 'none',
    padding: 0,
    margin: '8px 0 0 0',
  },
  speakerItem: {
    display: 'flex',
    flexDirection: 'column',
    padding: '8px',
    background: '#1a1a2e',
    borderRadius: '4px',
    marginBottom: '6px',
  },
  speakerIp: {
    fontWeight: 500,
    color: '#fff',
    fontSize: '0.875rem',
  },
  speakerUuid: {
    fontSize: '0.7rem',
    color: '#555',
    fontFamily: 'monospace',
    marginTop: '2px',
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
