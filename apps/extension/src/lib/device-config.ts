/**
 * Device Configuration and Encoder Selection
 *
 * Provides fallback encoder configuration when codec detection is not available.
 * Also handles session recording for learning from past sessions.
 */

import type { EncoderConfig, LatencyMode, AudioCodec, Bitrate } from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';

const log = createLogger('DeviceConfig');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persisted configuration state for learning from past sessions.
 */
export interface PersistedConfigState {
  /** Last configuration that ran without issues. */
  lastStableConfig: EncoderConfig | null;
  /** Last configuration that had audio quality issues. */
  lastBadConfig: EncoderConfig | null;
  /** Whether the last session had drops/issues. */
  lastSessionHadDrops: boolean;
  /** Timestamp of last successful session. */
  lastStableTimestamp: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Storage key for persisted config state. */
const STORAGE_KEY = 'deviceConfigState';

/**
 * Default fallback configuration.
 * Used when codec detection is not available.
 * Uses balanced settings (AAC-LC 192kbps stereo).
 */
const DEFAULT_CONFIG: EncoderConfig = {
  codec: 'aac-lc' as AudioCodec,
  bitrate: 192 as Bitrate,
  sampleRate: 48000,
  channels: 2,
  latencyMode: 'quality' as LatencyMode,
};

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads persisted configuration state from storage.
 * @returns The persisted state or default values
 */
export async function loadPersistedState(): Promise<PersistedConfigState> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const state = result[STORAGE_KEY] as PersistedConfigState | undefined;
    if (state) {
      return state;
    }
  } catch {
    // Storage access failed, return defaults
  }

  return {
    lastStableConfig: null,
    lastBadConfig: null,
    lastSessionHadDrops: false,
    lastStableTimestamp: null,
  };
}

/**
 * Saves configuration state to storage.
 * @param state - The state to persist
 */
export async function savePersistedState(state: PersistedConfigState): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
  } catch {
    // Storage access failed, ignore
  }
}

/**
 * Records a successful session (no drops).
 * @param config - The configuration that worked well
 */
export async function recordStableSession(config: EncoderConfig): Promise<void> {
  const state = await loadPersistedState();
  state.lastStableConfig = config;
  state.lastSessionHadDrops = false;
  state.lastStableTimestamp = Date.now();
  await savePersistedState(state);
}

/**
 * Records a session with audio quality issues.
 * @param config - The configuration that had issues
 */
export async function recordBadSession(config: EncoderConfig): Promise<void> {
  const state = await loadPersistedState();
  state.lastBadConfig = config;
  state.lastSessionHadDrops = true;
  await savePersistedState(state);
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Selection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks if two configurations are equivalent.
 * @param a - First configuration
 * @param b - Second configuration
 * @returns True if configurations are equivalent
 */
function configsEqual(a: EncoderConfig, b: EncoderConfig): boolean {
  return (
    a.codec === b.codec &&
    a.bitrate === b.bitrate &&
    a.sampleRate === b.sampleRate &&
    a.channels === b.channels &&
    a.latencyMode === b.latencyMode
  );
}

/**
 * Selects a fallback encoder configuration.
 *
 * This is used when codec detection is not available. Uses past session
 * history to avoid configurations that caused issues.
 *
 * @returns The selected encoder configuration
 */
export async function selectEncoderConfig(): Promise<EncoderConfig> {
  const state = await loadPersistedState();

  // If last session had drops and we have a stable config, use it
  if (state.lastSessionHadDrops && state.lastStableConfig) {
    log.info('Using last stable config due to previous session issues');
    return { ...state.lastStableConfig };
  }

  // If we have a recent stable config, prefer it
  if (state.lastStableConfig && state.lastStableTimestamp) {
    const ageMs = Date.now() - state.lastStableTimestamp;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    if (ageMs < sevenDaysMs) {
      // Don't use stable config if it's the same as what failed
      if (state.lastBadConfig && configsEqual(state.lastStableConfig, state.lastBadConfig)) {
        log.info('Stable config matches bad config, using default');
        return { ...DEFAULT_CONFIG };
      }

      log.info('Using recent stable config');
      return { ...state.lastStableConfig };
    }
  }

  return { ...DEFAULT_CONFIG };
}

/**
 * Gets a human-readable description of the selected configuration.
 * @param config - The encoder configuration
 * @returns A description string
 */
export function describeConfig(config: EncoderConfig): string {
  const channelStr = config.channels === 1 ? 'mono' : 'stereo';
  const modeStr = config.latencyMode === 'realtime' ? 'realtime' : 'quality';
  return `${config.codec} ${config.bitrate}kbps ${channelStr} (${modeStr} mode)`;
}
