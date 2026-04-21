# @thaumic-cast/core

## 0.11.0

### Minor Changes

- [#101](https://github.com/brew-lab/thaumic-cast/pull/101) [`b7776d3`](https://github.com/brew-lab/thaumic-cast/commit/b7776d33e513c1c82be4388829e8f725e3cb03e3) Thanks [@skezo](https://github.com/skezo)! - Add core-side pipeline instrumentation timeline for post-session diagnostics

  `LoggingStreamGuard` now accumulates per-tick pipeline snapshots (receive jitter from `StreamState`, cadence buffer health, HTTP delivery stats) and serializes them alongside the existing stream summary on drop. Snapshots land in a `Mutex`-guarded buffer so a mid-loop cadence abort (typical when Sonos closes HTTP) preserves the timeline instead of losing it.

  The cadence stream holds `Weak<StreamState>` rather than `Arc` so instrumentation does not prolong stream lifetime after cleanup; snapshots are skipped when the upgrade fails.

  Complements the extension-side metric timeline already shipped with the MSTP worker infrastructure — the two halves now cover all six pipeline stages end-to-end.

- [#103](https://github.com/brew-lab/thaumic-cast/pull/103) [`153a447`](https://github.com/brew-lab/thaumic-cast/commit/153a44754061c3d57d101d227d4654a863f201d9) Thanks [@skezo](https://github.com/skezo)! - Exchange companion version metadata over the existing connection so the extension can warn users when their desktop app or server is out of date.
  - `/health` now reports `appType` alongside the existing service identifier and stream limit. The extension reads it at discovery time so it knows which companion it's talking to before the WebSocket even connects.
  - The WebSocket `INITIAL_STATE` payload — sent on every connect, including the always-on control connection — now carries `appType`, `appVersion`, and `protocolVersion`. The extension persists these into the existing `connectionState` store; there is no separate companion-info storage.
  - `thaumic-core` exposes a new `AppInfo` / `AppType` pair passed to `AppState::new`. `apps/desktop` and `apps/server` each thread their own `env!("CARGO_PKG_VERSION")` through.
  - The extension compares the reported `protocolVersion` against `MIN_COMPATIBLE_PROTOCOL_VERSION` on every connect:
    - Renders a dismissible warning Alert in the popup with an "Update Desktop App" / "Update Server" / "Update" action button (chosen from `appType`) deep-linking to the GitHub releases page.
    - Renders a persistent inline "Update available" link in the popup footer and in the options About section, even after the Alert has been dismissed, so the user always has a path to the releases page.
    - Dismissal is keyed by `appVersion` (or `null` for pre-0.4.0 companions) in `chrome.storage.local`, so rolling forward — including from "unknown" to a real version — re-arms the warning.
  - The popup footer copy is type-aware: "Connected to Desktop App", "Connected to Server", or just "Connected" when the type is unknown.
  - Older companions that omit the new fields are treated as out-of-date (not "assume compatible"), since the extension may have been auto-updated by Chrome ahead of the user updating the companion. The Alert and footer link still appear; copy degrades gracefully ("Your app predates this extension and can't report its version").
  - Shared UI: new `link` variant on `<Button>` for inline text-link CTAs.

  No new remote calls are introduced — the check runs entirely off discovery and the existing WebSocket, preserving the privacy promise in PRIVACY.md.

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

- [#90](https://github.com/brew-lab/thaumic-cast/pull/90) [`facd9e8`](https://github.com/brew-lab/thaumic-cast/commit/facd9e8d5814807947193c2fd8e80b566223bb38) Thanks [@skezo](https://github.com/skezo)! - Add WASAPI process-specific loopback capture for browser-wide audio streaming on Windows

  Instead of capturing audio per-tab via the Chrome `tabCapture` API, this adds an alternative mode that captures all audio from the browser process at the OS level using Windows Audio Session API (WASAPI) process loopback. Requires Windows 10 build 20348+.

  **New packages:**
  - `thaumic-capture` crate: platform-gated WASAPI capture library with `WasapiSource`, browser PID discovery via `CreateToolhelp32Snapshot`, and COM/MMCSS-elevated capture thread
  - `wasapi-capture` CLI: diagnostic tool that captures N seconds of audio from a PID, outputs Float32 WAV + timing stats for validation

  **Core (`thaumic-core`):**
  - `capture` module with platform-agnostic `AudioSource`/`AudioSink`/`CaptureHandle` traits and `CaptureSourceFactory` factory pattern (avoids cyclic dependency with `thaumic-capture`)
  - `StreamSinkBridge` converts Float32 → PCM16 on the capture thread and pushes into existing `StreamRegistry` pipeline
  - `StreamCoordinator::start_capture_stream()` wires up the full capture → stream path
  - WebSocket handler adds `START_BROWSER_CAPTURE`, `STOP_BROWSER_CAPTURE`, and async `BROWSER_CAPTURE_ERROR` monitoring (process exit, device disconnect)

  **Desktop app:**
  - `WasapiCaptureFactory` bridges `thaumic-capture` into core's factory trait
  - `get_capture_capabilities` Tauri command exposes platform availability to frontend

  **Extension:**
  - New `captureMode` setting (`tab` | `browser`) with UI toggle in Advanced Settings
  - Mode exclusivity enforcement (tab and browser capture cannot coexist)
  - Browser capture flow: sends `START_BROWSER_CAPTURE` over WebSocket, server handles capture — no offscreen AudioWorklet needed
  - `StreamSession` refactored to handle both capture modes with appropriate teardown
  - `BROWSER_CAPTURE_ERROR` handling for graceful recovery on capture failures

  **Protocol:**
  - `BROWSER_CAPTURE_ERROR` message type with Zod schemas added to WebSocket protocol

### Patch Changes

- [#106](https://github.com/brew-lab/thaumic-cast/pull/106) [`d659f5e`](https://github.com/brew-lab/thaumic-cast/commit/d659f5e6ed12f7f701d5c8cb6601d654ab2c7053) Thanks [@skezo](https://github.com/skezo)! - Tighten the PCM jitter-buffer pipeline and add cadence startup diagnostics.
  - Prefill frames returned by `subscribe()` are trimmed to the intended buffer depth (`jitter_buffer_ms / frame_duration_ms`) before being queued, keeping the newest frames. Previously a resume with a populated ring buffer could replay up to a full second of stale audio before catching up to live.
  - The cadence queue's drop threshold is now `buffer_depth × JITTER_OVERFLOW_MULTIPLIER` (3) instead of a single `queue_size` value, so short producer bursts (e.g. Chrome scheduling gaps dumping backed-up frames) don't drop frames immediately. Steady-state queue depth is unchanged.
  - Introduces `CadenceConfig::new(silence, jitter_buffer_ms, frame_ms, format, prefill)` as the canonical construction path; it computes `overflow_cap` and trims prefill in one place instead of duplicating the math in `api/stream.rs`.
  - Adds two startup diagnostic logs — `[Cadence] Startup: prefill_frames=…` and `[Cadence] First yield: {audio|silence}` — so field logs can show whether fresh casts begin with audio or silence, independent of downstream behavior.

  Startup buffering and underrun recovery behavior match pre-PR: the pre-subscribe sleep honors the user-configured `jitter_buffer_ms` (skipped on resume), and the cadence loop emits silence on underrun and resumes as soon as a frame is available.

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

- [#99](https://github.com/brew-lab/thaumic-cast/pull/99) [`a097322`](https://github.com/brew-lab/thaumic-cast/commit/a0973226e77f104d87544597483c74ef260b3e66) Thanks [@skezo](https://github.com/skezo)! - Harden streaming network path and diagnostic log retention

  Four isolated fixes to the local streaming daemon and desktop app:

  **Core (`thaumic-core`):**
  - TCP_NODELAY on all accepted connections disables Nagle's algorithm so small PCM frames (1920 bytes) ship immediately instead of being batched, reducing delivery jitter to Sonos.
  - TCP keepalive on accepted connections (10s idle, 5s interval, 3 retries on Linux) detects stalled speakers within ~25s instead of the default ~2 hours, preventing async tasks from being held alive on dead connections.
  - SSDP discovery now skips link-local (`169.254.0.0/16`) addresses that cause bind failures on adapters like Bluetooth with no real connectivity, and expands the virtual-interface prefix list (Windows `vEthernet`, WireGuard, Tailscale, ZeroTier) that cannot reach local Sonos speakers.

  **Desktop:**
  - Raises log max file size to 1 MB so pipeline diagnostic dumps survive across sessions without rotation.

- [#105](https://github.com/brew-lab/thaumic-cast/pull/105) [`32ae247`](https://github.com/brew-lab/thaumic-cast/commit/32ae2471d81ace318b32080badceb578b8019ae5) Thanks [@skezo](https://github.com/skezo)! - Rename `streamingBufferMs` setting to `jitterBufferMs` across the stack

  Pure rename — no behavior change. Every value, default, clamp range, and UI option stays the same. Identifier updated on the protocol, core, extension, and desktop surfaces, plus docstrings and the one user-facing label ("Streaming Buffer" → "Jitter Buffer"). The setting has always functioned as a jitter buffer (holding PCM frames to smooth WebSocket-to-Sonos delivery variance), so the name now matches the role.

  Sets up a follow-up change that turns this from a passive sizing hint into an active fill-gate / refill-on-underrun state machine.

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
