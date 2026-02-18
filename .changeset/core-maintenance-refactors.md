---
'thaumic-core': patch
'@thaumic-cast/protocol': patch
---

Refactor core internals and improve multi-speaker performance

**Refactoring:**

- Decompose `StreamCoordinator` into focused modules: `PlaybackSessionStore`, `SyncGroupManager`, `VolumeRouter`
- Decompose Sonos client into focused modules: `didl`, `grouping`, `playback`, `retry`, `subscription_arbiter`, `volume`, `zone_groups`
- Extract cadence streaming pipeline from `http.rs` into `stream/cadence.rs`
- Deduplicate retry logic, tighten module visibility, clean up logs

**Performance:**

- Parallelize sequential SOAP calls across multi-room playback
- Gate server-side latency monitoring behind client `videoSyncEnabled` opt-in to avoid unnecessary overhead

**Fixes:**

- Fix stale `sync_ips` cleanup when speakers leave a session
- Fix stale log prefixes and correct module visibility
- Add 1ms timeout to test HTTP clients to avoid TCP SYN hangs

**Protocol:**

- Add `videoSyncEnabled` boolean field to `WsStartPlaybackPayload` (defaults to `false`, backward compatible)
