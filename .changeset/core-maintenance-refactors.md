---
'@thaumic-cast/core': patch
'@thaumic-cast/protocol': patch
---

Refactor core internals, remove dead code, and improve multi-speaker performance

**Refactoring:**

- Decompose `StreamCoordinator` into focused modules: `PlaybackSessionStore`, `SyncGroupManager`, `VolumeRouter`
- Decompose Sonos client into focused modules: `didl`, `grouping`, `playback`, `retry`, `subscription_arbiter`, `volume`, `zone_groups`
- Extract cadence streaming pipeline from `http.rs` into `stream/cadence.rs`
- Extract stream_audio handler, StartPlayback handler, and parse_stream_config from WS handshake into focused modules
- Extract helpers: `CleanupOrder`, `CrossfadeState`, `with_epoch_tracking` combinator, `teardown_speaker`, `ensure_playing`
- Replace `SoapRequestBuilder` with `soap_request` function
- Replace `AppStateBuilder` with `AppState::new` constructor
- Rename `StreamManager` to `StreamRegistry`
- Remove `TaggedFrame` enum, inline epoch tracking
- Merge `gena_event_builder` into `gena_parser`
- Move NOTIFY service routing from subscription manager to event processor
- Deduplicate `BroadcastEventBridge` emit methods with macro
- Deduplicate `cleanup_stream_if_no_sessions` into `SyncGroupManager`
- Remove redundant `stream_coordinator` field from `GenaEventProcessor`
- Remove redundant `broadcast_tx` from `AppState`
- Unify sync vs non-sync start path in `StreamCoordinator`
- Normalize `SonosEvent` imports to canonical events path
- Deduplicate retry logic, tighten module visibility, clean up logs

**Dead code removal:**

- Remove unused traits: `Transcoder`/`Passthrough`, `Lifecycle`, `TaskSpawner`, `CoreState`
- Remove unused implementations: `NoopEventEmitter`, `LoggingEventEmitter`
- Remove unused methods: `UrlBuilder::websocket_url`, `StreamingRuntime::handle`, `BroadcastEventBridge::clear_external_emitter`, `SonosClientImpl::with_discovery_config`
- Remove dead `ErrorCode` impls for `SoapError` and `GenaError`, 3 dead error variants, dead discovery error variants
- Remove dead fields: `DeviceInfo.model_number`, `PlaybackEpoch` telemetry and dead fields, `PositionInfo` dead fields, `StreamMetadata` album/artwork fields, 9 dead `Config` fields
- Remove dead `raise_process_priority` function

**Performance:**

- Parallelize sequential SOAP calls across multi-room playback
- Gate server-side latency monitoring behind client `videoSyncEnabled` opt-in to avoid unnecessary overhead
- Make delivery tracking lock-free

**Fixes:**

- Fix stale `sync_ips` cleanup when speakers leave a session
- Fix stale log prefixes and correct module visibility
- Pass `preferred_port` to `NetworkContext` in `bootstrap_services`
- Add 1ms timeout to test HTTP clients to avoid TCP SYN hangs

**Protocol:**

- Add `videoSyncEnabled` boolean field to `WsStartPlaybackPayload` (defaults to `false`, backward compatible)
