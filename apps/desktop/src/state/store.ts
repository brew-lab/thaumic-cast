import { signal } from '@preact/signals';
import { invoke } from '@tauri-apps/api/core';

// Types mirroring Rust backend
export interface Speaker {
  uuid: string;
  name: string;
  model: string;
  ip: string;
}

export interface ZoneGroupMember {
  uuid: string;
  ip: string;
  zoneName: string;
  model: string;
}

export interface ZoneGroup {
  id: string;
  name: string;
  coordinatorUuid: string;
  coordinatorIp: string;
  members: ZoneGroupMember[];
}

/** Map of speaker IP to transport state (Playing, Stopped, etc.). */
export type TransportStates = Record<string, string>;

// Global State
export const speakers = signal<Speaker[]>([]);
export const groups = signal<ZoneGroup[]>([]);
export const transportStates = signal<TransportStates>({});
export const serverPort = signal<number>(0);
export const isLoading = signal<boolean>(false);
export const stats = signal<AppStats | null>(null);

export interface AppStats {
  connectionCount: number;
  subscriptionCount: number;
  streamCount: number;
  localIp: string;
  port: number;
}

// Actions

/**
 * Fetches current application statistics from the backend.
 * Updates the stats and serverPort signals.
 */
export const fetchStats = async (): Promise<void> => {
  const fetchedStats = await invoke<AppStats>('get_stats');
  stats.value = fetchedStats;
  serverPort.value = fetchedStats.port;
};

/**
 * Fetches transport states from the backend.
 * Updates the transportStates signal.
 */
export const fetchTransportStates = async (): Promise<void> => {
  const states = await invoke<TransportStates>('get_transport_states');
  transportStates.value = states;
};

/**
 * Fetches zone groups, transport states, and stats from the backend.
 * Updates the groups and transportStates signals and triggers a stats refresh.
 */
export const fetchGroups = async (): Promise<void> => {
  try {
    isLoading.value = true;
    const [fetchedGroups, states] = await Promise.all([
      invoke<ZoneGroup[]>('get_groups'),
      invoke<TransportStates>('get_transport_states'),
    ]);
    groups.value = fetchedGroups;
    transportStates.value = states;
    await fetchStats();
  } finally {
    isLoading.value = false;
  }
};

/**
 * Triggers a manual SSDP discovery refresh.
 * Polls for updated groups after a short delay.
 */
export const refreshTopology = async (): Promise<void> => {
  await invoke('refresh_topology');
  // Poll briefly after trigger
  setTimeout(fetchGroups, 1000);
};

/**
 * Starts audio playback on a speaker.
 * @param ip - Speaker IP address
 * @param streamId - Stream identifier (default: 'default')
 */
export const startPlayback = async (ip: string, streamId: string = 'default'): Promise<void> => {
  await invoke('start_playback', { ip, streamId });
};

/**
 * Stops all active streams and playback.
 * Refreshes stats after completion.
 */
export const stopAll = async (): Promise<void> => {
  await invoke('clear_all_streams');
  await fetchStats();
};

/**
 * Force-closes all WebSocket connections.
 * Refreshes stats after completion.
 * @returns Number of connections closed
 */
export const clearAllConnections = async (): Promise<number> => {
  const count = await invoke<number>('clear_all_connections');
  await fetchStats();
  return count;
};

/**
 * Gracefully restarts the server.
 * Stops all playback and streams before restarting.
 */
export const restartServer = async (): Promise<void> => {
  await invoke('restart_server');
};

/**
 * Gets whether autostart is enabled.
 * @returns True if autostart is enabled
 */
export const getAutostartEnabled = async (): Promise<boolean> => {
  return invoke<boolean>('get_autostart_enabled');
};

/**
 * Sets whether autostart is enabled.
 * @param enabled - Whether to enable autostart
 */
export const setAutostartEnabled = async (enabled: boolean): Promise<void> => {
  await invoke('set_autostart_enabled', { enabled });
};
