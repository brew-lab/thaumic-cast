---
'@thaumic-cast/protocol': patch
---

Reorganize protocol package into logical modules

Split `index.ts` (1,570 lines) into 9 focused modules for better maintainability:

- `audio.ts` - Codecs, bitrates, sample rates, bit depths, constants
- `encoder.ts` - EncoderConfig, codec metadata, validation helpers
- `codec-support.ts` - Runtime detection, presets, scoring
- `stream.ts` - StreamConfig, CastStatus, ActiveCast, PlaybackResult
- `websocket.ts` - All WsMessage types and schemas
- `sonos.ts` - ZoneGroup, TransportState, SonosStateSnapshot
- `events.ts` - SonosEvent, StreamEvent, LatencyEvent, BroadcastEvent
- `media.ts` - MediaMetadata, TabMediaState, display helpers
- `video-sync.ts` - VideoSyncState, LatencySample, constants

100% backwards compatible - all existing imports continue to work via barrel re-exports.
