/**
 * @thaumic-cast/protocol
 *
 * Shared TypeScript types and schemas for Thaumic Cast.
 * This barrel re-exports all types from the organized modules.
 */

// Audio primitives: codecs, bitrates, sample rates, bit depths, constants
export * from './src/audio.js';

// Encoder configuration and codec metadata
export * from './src/encoder.js';

// Runtime codec support detection and dynamic presets
export * from './src/codec-support.js';

// Stream configuration and active cast types
export * from './src/stream.js';

// WebSocket message types and schemas
export * from './src/websocket.js';

// Sonos state types (groups, transport, sessions)
export * from './src/sonos.js';

// Rooms folded from Sonos groups (bonded devices, grouped rooms)
export * from './src/rooms.js';

// Event types (sonos, stream, latency and its playout estimate, broadcast)
export * from './src/events.js';

// Media metadata and tab state types
export * from './src/media.js';

// Video sync status (per cast, for the popup)
export * from './src/video-sync.js';

// Streaming policy configuration (buffer sizing, drop thresholds)
export * from './src/streaming-policy.js';
