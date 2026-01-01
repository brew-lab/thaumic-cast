/**
 * Device Capability Detection and Encoder Configuration Selection
 *
 * Detects device capabilities and selects appropriate encoder configuration
 * to balance audio quality with device performance. Persists configuration
 * history to learn from past sessions.
 */

import type {
  EncoderConfig,
  LatencyMode,
  AudioCodec,
  Bitrate,
  PowerState,
} from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';

const log = createLogger('DeviceConfig');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Device capability tier based on hardware signals.
 */
export type DeviceTier = 'high-end' | 'balanced' | 'low-end';

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

/**
 * Device capability signals.
 */
export interface DeviceCapabilities {
  /** Device memory in GB (navigator.deviceMemory). */
  deviceMemory: number | undefined;
  /** Number of logical CPU cores (navigator.hardwareConcurrency). */
  hardwareConcurrency: number | undefined;
}

/** Low battery threshold (as percentage 0-100) - force low-end config below this level. */
const LOW_BATTERY_THRESHOLD = 20;

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Storage key for persisted config state. */
const STORAGE_KEY = 'deviceConfigState';

/** Thresholds for device tier classification. */
const LOW_END_MEMORY_THRESHOLD = 4; // GB
const LOW_END_CORES_THRESHOLD = 4;

// ─────────────────────────────────────────────────────────────────────────────
// Config Presets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * High-end device configuration.
 * Maximum quality, stereo, quality latency mode.
 */
const HIGH_END_CONFIG: EncoderConfig = {
  codec: 'aac-lc' as AudioCodec,
  bitrate: 256 as Bitrate,
  sampleRate: 48000,
  channels: 2,
  latencyMode: 'quality' as LatencyMode,
};

/**
 * Balanced device configuration.
 * Good quality, stereo, quality latency mode.
 */
const BALANCED_CONFIG: EncoderConfig = {
  codec: 'aac-lc' as AudioCodec,
  bitrate: 192 as Bitrate,
  sampleRate: 48000,
  channels: 2,
  latencyMode: 'quality' as LatencyMode,
};

/**
 * Low-end device configuration.
 * Reduced quality, mono, realtime latency mode for maximum performance.
 */
const LOW_END_CONFIG: EncoderConfig = {
  codec: 'aac-lc' as AudioCodec,
  bitrate: 128 as Bitrate,
  sampleRate: 48000,
  channels: 1,
  latencyMode: 'realtime' as LatencyMode,
};

// ─────────────────────────────────────────────────────────────────────────────
// Device Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gets device capability signals from the browser.
 * @returns Device capability information
 */
export function getDeviceCapabilities(): DeviceCapabilities {
  return {
    // navigator.deviceMemory is not available in all browsers
    deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    hardwareConcurrency: navigator.hardwareConcurrency,
  };
}

/**
 * Determines device tier based on capability signals.
 * @param caps - Device capabilities
 * @returns The device tier
 */
export function classifyDeviceTier(caps: DeviceCapabilities): DeviceTier {
  const memory = caps.deviceMemory;
  const cores = caps.hardwareConcurrency;

  // If we can't detect capabilities, assume balanced
  if (memory === undefined && cores === undefined) {
    return 'balanced';
  }

  // Low-end: either memory or cores below threshold
  if (
    (memory !== undefined && memory <= LOW_END_MEMORY_THRESHOLD) ||
    (cores !== undefined && cores <= LOW_END_CORES_THRESHOLD)
  ) {
    return 'low-end';
  }

  // High-end: good memory AND good cores
  if (memory !== undefined && memory >= 8 && cores !== undefined && cores >= 8) {
    return 'high-end';
  }

  return 'balanced';
}

/**
 * Gets the default configuration for a device tier.
 * @param tier - The device tier
 * @returns The default encoder configuration
 */
export function getConfigForTier(tier: DeviceTier): EncoderConfig {
  switch (tier) {
    case 'high-end':
      return { ...HIGH_END_CONFIG };
    case 'low-end':
      return { ...LOW_END_CONFIG };
    case 'balanced':
    default:
      return { ...BALANCED_CONFIG };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Power State Detection (via Desktop App)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks if device is on battery power and should use low-power config.
 * Uses power state from desktop app (via WebSocket), which has native OS access.
 * This bypasses browser Battery API restrictions (Permissions-Policy, Brave, etc.).
 * @param desktopPowerState - Power state from desktop app (null if not connected)
 * @returns Object with result and whether power info was available
 */
export function checkPowerState(desktopPowerState: PowerState | null): {
  onBattery: boolean;
  powerInfoAvailable: boolean;
  charging?: boolean;
  level?: number;
} {
  if (!desktopPowerState) {
    // Desktop not connected or power detection failed
    log.debug('No power state from desktop app');
    return { onBattery: false, powerInfoAvailable: false };
  }

  // On AC power = not on battery
  const onBattery = !desktopPowerState.onAcPower;

  // Also force low-power if battery is critically low
  const criticallyLow =
    desktopPowerState.batteryLevel !== null &&
    desktopPowerState.batteryLevel < LOW_BATTERY_THRESHOLD;

  return {
    onBattery: onBattery || criticallyLow,
    powerInfoAvailable: true,
    charging: desktopPowerState.charging,
    level: desktopPowerState.batteryLevel ?? undefined,
  };
}

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
 * Checks if config A is "higher quality" than config B.
 * @param a - First configuration
 * @param b - Second configuration
 * @returns True if A is higher quality than B
 */
function isHigherQuality(a: EncoderConfig, b: EncoderConfig): boolean {
  // More channels = higher quality
  if (a.channels > b.channels) return true;
  if (a.channels < b.channels) return false;

  // Higher bitrate = higher quality
  if (a.bitrate > b.bitrate) return true;
  if (a.bitrate < b.bitrate) return false;

  // Quality mode > realtime mode
  if (a.latencyMode === 'quality' && b.latencyMode === 'realtime') return true;

  return false;
}

/**
 * Selects the appropriate encoder configuration based on device capabilities,
 * battery state, and past session history.
 *
 * Selection logic:
 * 1. If on battery power, force low-end config (ignore stable config history)
 * 2. If last session had drops and we have a stable config, use stable config
 * 3. If last session had drops and stable config equals device tier default, downgrade
 * 4. If we have a stable config that's not too old (< 7 days), use it
 * 5. Otherwise, use device tier default
 *
 * @param onBattery - Whether device is on battery (pre-checked to avoid double API call)
 * @returns The selected encoder configuration
 */
export async function selectEncoderConfig(onBattery = false): Promise<EncoderConfig> {
  // If on battery, force low-end config to prevent source starvation
  // Ignore lastStableConfig since it was likely recorded while plugged in
  if (onBattery) {
    return { ...LOW_END_CONFIG };
  }

  const caps = getDeviceCapabilities();
  const tier = classifyDeviceTier(caps);
  const tierDefault = getConfigForTier(tier);
  const state = await loadPersistedState();

  // If last session had drops, be conservative
  if (state.lastSessionHadDrops) {
    // If we have a known stable config, use it
    if (state.lastStableConfig) {
      return { ...state.lastStableConfig };
    }

    // Otherwise, if we're not already at low-end, downgrade
    if (tier !== 'low-end') {
      const lowerTier = tier === 'high-end' ? 'balanced' : 'low-end';
      return getConfigForTier(lowerTier);
    }
  }

  // If we have a recent stable config, prefer it
  if (state.lastStableConfig && state.lastStableTimestamp) {
    const ageMs = Date.now() - state.lastStableTimestamp;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    if (ageMs < sevenDaysMs) {
      // Don't use stable config if it's the same as what failed
      if (state.lastBadConfig && configsEqual(state.lastStableConfig, state.lastBadConfig)) {
        // Stable and bad are the same - something changed, use tier default
        return tierDefault;
      }

      // Don't downgrade from tier default unless we had issues
      if (!isHigherQuality(tierDefault, state.lastStableConfig)) {
        return { ...state.lastStableConfig };
      }
    }
  }

  return tierDefault;
}

/**
 * Gets a human-readable description of the selected configuration.
 * @param config - The encoder configuration
 * @param lowPowerMode - Whether low-power mode was used
 * @returns A description string
 */
export function describeConfig(config: EncoderConfig, lowPowerMode?: boolean): string {
  const channelStr = config.channels === 1 ? 'mono' : 'stereo';
  const modeStr = config.latencyMode === 'realtime' ? 'realtime' : 'quality';
  const powerStr = lowPowerMode ? ' [battery]' : '';
  return `${config.codec} ${config.bitrate}kbps ${channelStr} (${modeStr} mode)${powerStr}`;
}

/**
 * Result of encoder config selection.
 */
export interface EncoderConfigResult {
  /** The selected encoder configuration. */
  config: EncoderConfig;
  /** Whether low-power (battery) mode was used. */
  lowPowerMode: boolean;
  /** Whether power info was available from desktop app. */
  powerInfoAvailable: boolean;
  /** Whether device is currently charging (undefined if not available). */
  charging?: boolean;
  /** Battery level 0-100 if available. */
  batteryLevel?: number;
}

/**
 * Selects encoder config and returns additional context.
 * Uses power state from desktop app to determine if on battery.
 * @param desktopPowerState - Power state from desktop app (null if not connected)
 * @returns The config, power mode, and power info
 */
export async function selectEncoderConfigWithContext(
  desktopPowerState: PowerState | null,
): Promise<EncoderConfigResult> {
  // Check power state from desktop
  const powerState = checkPowerState(desktopPowerState);
  const config = await selectEncoderConfig(powerState.onBattery);

  return {
    config,
    lowPowerMode: powerState.onBattery,
    powerInfoAvailable: powerState.powerInfoAvailable,
    charging: powerState.charging,
    batteryLevel: powerState.level,
  };
}
