# @thaumic-cast/core

## 0.11.0

### Minor Changes

- [#72](https://github.com/brew-lab/thaumic-cast/pull/72) [`c0c6033`](https://github.com/brew-lab/thaumic-cast/commit/c0c60339b4a5d75168296d1ff6e53ad51b97f422) Thanks [@skezo](https://github.com/skezo)! - Add synchronized multi-speaker playback using Sonos x-rincon protocol

  When streaming to multiple Sonos speakers, audio now plays in perfect sync by using Sonos's native group coordination mechanism instead of sending independent streams to each speaker.

  **How it works:**
  - One speaker becomes the "coordinator" and receives the actual stream URL
  - Other speakers become "slaves" that join the coordinator via `x-rincon:{uuid}` protocol
  - Slaves sync their playback timing to the coordinator, eliminating drift

  **Changes:**
  - Add `join_group()` and `leave_group()` SOAP commands to sonos client
  - Extend `SonosPlayback` trait with group coordination methods
  - Add `GroupRole` enum (Coordinator/Slave) to track speaker roles
  - Update `PlaybackSession` with role, coordinator_ip, and coordinator_uuid fields
  - Implement coordinator selection (prefers existing Sonos group coordinators)
  - Refactor `start_playback_multi` to use synchronized group playback
  - Add group-aware cleanup in stop methods (slaves unjoin, coordinator cascade)
  - Fix `get_expected_stream` to handle x-rincon URIs correctly for slaves
  - Add `get_member_uuid_by_ip` helper for UUID lookup across all group members

  **Behavior:**
  - Single speaker: unchanged (no grouping)
  - Multiple speakers: synchronized via x-rincon protocol
  - Fallback: independent playback if UUID lookup fails
  - User's existing Sonos groups are restored after streaming ends (best-effort)

### Patch Changes

- [#81](https://github.com/brew-lab/thaumic-cast/pull/81) [`77a19e2`](https://github.com/brew-lab/thaumic-cast/commit/77a19e21150e6b7cd35af44fb3bd6d47edc4d636) Thanks [@skezo](https://github.com/skezo)! - Refactor core internals, remove dead code, and improve multi-speaker performance

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

- [#72](https://github.com/brew-lab/thaumic-cast/pull/72) [`8e409b6`](https://github.com/brew-lab/thaumic-cast/commit/8e409b6ac9a1297cde61a3faee5c2336b10c2437) Thanks [@skezo](https://github.com/skezo)! - Add opt-in setting for synchronized multi-speaker playback

  Synchronized group playback is now controlled by a user setting rather than being automatic. This allows users who prefer independent streams (and are okay with potential audio drift) to keep their existing Sonos speaker groupings unchanged.

  **Changes:**
  - Add "Synchronize speakers" toggle in Options > Advanced section
  - Add `syncSpeakers` field to extension settings (default: false)
  - Thread `syncSpeakers` flag through the message chain from extension to server
  - Store `syncSpeakers` preference in session for resume/reconnect scenarios
  - Server uses independent playback when `syncSpeakers` is false

  **Behavior:**
  - Setting disabled (default): Each speaker receives independent streams
  - Setting enabled: Speakers are grouped via x-rincon protocol for perfect sync
  - Single speaker casts are unaffected by this setting
  - Resume after pause respects the original sync preference from cast start
