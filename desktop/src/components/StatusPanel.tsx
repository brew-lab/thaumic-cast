import { useState } from 'preact/hooks';
import { invoke } from '@tauri-apps/api/core';

interface Speaker {
  uuid: string;
  ip: string;
}

interface Status {
  server_running: boolean;
  port: number;
  active_streams: number;
  discovered_speakers: number;
}

interface Props {
  status: Status;
  onRefresh: () => void;
}

export function StatusPanel({ status, onRefresh }: Props) {
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [loadingSpeakers, setLoadingSpeakers] = useState(false);

  const discoverSpeakers = async () => {
    setLoadingSpeakers(true);
    try {
      const result = await invoke<Speaker[]>('get_speakers');
      setSpeakers(result);
    } catch (e) {
      console.error('Failed to discover speakers:', e);
    } finally {
      setLoadingSpeakers(false);
    }
  };

  return (
    <div style={styles.panel}>
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Server Status</h3>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>Status:</span>
          <span
            style={{ ...styles.statusValue, color: status.server_running ? '#4caf50' : '#f44336' }}
          >
            {status.server_running ? 'Running' : 'Stopped'}
          </span>
        </div>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>Port:</span>
          <span style={styles.statusValue}>{status.port}</span>
        </div>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>Active Streams:</span>
          <span style={styles.statusValue}>{status.active_streams}</span>
        </div>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <h3 style={styles.sectionTitle}>Speakers</h3>
          <button style={styles.button} onClick={discoverSpeakers} disabled={loadingSpeakers}>
            {loadingSpeakers ? 'Scanning...' : 'Discover'}
          </button>
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
          <p style={styles.emptyText}>
            No speakers discovered. Click "Discover" to scan your network.
          </p>
        )}
      </div>

      <div style={styles.footer}>
        <button style={styles.refreshButton} onClick={onRefresh}>
          Refresh Status
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    background: '#16213e',
    borderRadius: '8px',
    padding: '16px',
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
    fontSize: '0.875rem',
    fontWeight: 600,
    color: '#aaa',
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
  },
  statusValue: {
    fontWeight: 500,
    color: '#fff',
  },
  button: {
    background: '#0f3460',
    color: '#fff',
    border: 'none',
    padding: '6px 12px',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.75rem',
    fontWeight: 500,
  },
  speakerList: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
  },
  speakerItem: {
    display: 'flex',
    flexDirection: 'column',
    padding: '8px',
    background: '#1a1a2e',
    borderRadius: '4px',
    marginBottom: '8px',
  },
  speakerIp: {
    fontWeight: 500,
    color: '#fff',
    marginBottom: '2px',
  },
  speakerUuid: {
    fontSize: '0.75rem',
    color: '#666',
    fontFamily: 'monospace',
  },
  emptyText: {
    color: '#666',
    fontSize: '0.875rem',
  },
  footer: {
    marginTop: '20px',
    paddingTop: '16px',
    borderTop: '1px solid #1a1a2e',
  },
  refreshButton: {
    background: 'transparent',
    color: '#888',
    border: '1px solid #333',
    padding: '8px 16px',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.875rem',
    width: '100%',
  },
};
