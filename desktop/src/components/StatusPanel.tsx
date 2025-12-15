import { useState, useEffect } from 'preact/hooks';
import { invoke } from '@tauri-apps/api/core';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import type { LocalGroup, Status } from '../types';

interface Props {
  status: Status;
}

function formatTimestamp(unixTimestamp: number | null | undefined): string {
  if (!unixTimestamp) return 'Never';
  const date = new Date(unixTimestamp * 1000);
  return date.toLocaleTimeString();
}

export function StatusPanel({ status }: Props) {
  const [groups, setGroups] = useState<LocalGroup[]>([]);
  const [scanning, setScanning] = useState(false);
  const [autostartEnabled, setAutostartEnabled] = useState<boolean | null>(null);
  const [autostartLoading, setAutostartLoading] = useState(false);

  // Load groups on mount (requires speakers to be cached first)
  useEffect(() => {
    const loadGroups = async () => {
      try {
        // Ensure speakers are cached first
        await invoke('get_speakers');
        const result = await invoke<LocalGroup[]>('get_groups');
        setGroups(result);
      } catch (e) {
        console.error('Failed to load groups:', e);
      }
    };
    loadGroups();
  }, []);

  useEffect(() => {
    isEnabled().then(setAutostartEnabled).catch(console.error);
  }, []);

  const handleScan = async () => {
    setScanning(true);
    try {
      // Refresh speakers first, then get updated groups
      await invoke('refresh_speakers');
      const result = await invoke<LocalGroup[]>('get_groups');
      setGroups(result);
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

      {/* Sonos */}
      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <h3 style={{ ...styles.sectionTitle, marginBottom: 0 }}>Sonos</h3>
          <button style={styles.scanButton} onClick={handleScan} disabled={scanning}>
            {scanning ? 'Scanning...' : 'Scan'}
          </button>
        </div>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>Last Scan</span>
          <span style={styles.statusValue}>{formatTimestamp(status.last_discovery_at)}</span>
        </div>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>Devices</span>
          <span style={styles.statusValue}>{status.discovered_speakers}</span>
        </div>
        <div style={styles.statusRow}>
          <span style={styles.statusLabel}>Groups</span>
          <span style={styles.statusValue}>{groups.length}</span>
        </div>

        {groups.length > 0 ? (
          <div style={styles.groupList}>
            {groups.map((group) => (
              <div key={group.id} style={styles.groupItem}>
                <div style={styles.groupHeader}>
                  <span style={styles.groupName}>{group.name}</span>
                  <span style={styles.groupMemberCount}>
                    {group.members.length} {group.members.length === 1 ? 'speaker' : 'speakers'}
                  </span>
                </div>
                <ul style={styles.memberList}>
                  {group.members.map((member) => (
                    <li key={member.uuid} style={styles.memberItem}>
                      <span style={styles.memberName}>
                        {member.zoneName}
                        {member.uuid === group.coordinatorUuid && (
                          <span style={styles.coordinatorBadge}>coordinator</span>
                        )}
                      </span>
                      <span style={styles.memberModel}>{member.model}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
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
  groupList: {
    marginTop: '12px',
  },
  groupItem: {
    background: '#1a1a2e',
    borderRadius: '6px',
    padding: '10px',
    marginBottom: '8px',
  },
  groupHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '8px',
  },
  groupName: {
    fontWeight: 600,
    color: '#fff',
    fontSize: '0.875rem',
  },
  groupMemberCount: {
    fontSize: '0.7rem',
    color: '#666',
  },
  memberList: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
  },
  memberItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '4px 0',
    borderTop: '1px solid #252545',
  },
  memberName: {
    color: '#ccc',
    fontSize: '0.8rem',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  memberModel: {
    color: '#555',
    fontSize: '0.7rem',
  },
  coordinatorBadge: {
    fontSize: '0.6rem',
    color: '#4caf50',
    background: '#1a3d1a',
    padding: '1px 4px',
    borderRadius: '3px',
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
