# @thaumic-cast/desktop

## 0.10.4

## 0.10.3

### Patch Changes

- [#47](https://github.com/brew-lab/thaumic-cast/pull/47) [`b8b75b1`](https://github.com/brew-lab/thaumic-cast/commit/b8b75b1c21c8b462238c8df6b7e3a27cab0b4310) Thanks [@skezo](https://github.com/skezo)! - Update Chrome Web Store link in onboarding to point to the published extension listing.

## 0.10.2

## 0.10.1

## 0.10.0

### Minor Changes

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`6921795`](https://github.com/brew-lab/thaumic-cast/commit/6921795b559217b5ee5342852e7c59b80fc858d4) Thanks [@skezo](https://github.com/skezo)! - Add mDNS service discovery and user-configurable streaming buffer

  **mDNS Service Advertisement**
  - Advertise Thaumic Cast as `_thaumic._tcp.local.` for native client discovery
  - Unique instance name per hostname to avoid conflicts
  - TXT records include http_path, ws_path, and version
  - Auto-unregisters on shutdown; best-effort if mDNS unavailable

  **User-Configurable Streaming Buffer**
  - Add streaming buffer setting (100-1000ms, default 200ms) for PCM mode
  - Higher values provide more jitter absorption at the cost of latency
  - Exposed in extension Audio options panel
  - Dynamically derives WAV cadence queue size from buffer setting

  **Extension Improvements**
  - Skip redundant metadata cache updates for better performance
  - Reduce keep-audible gain and optimize PCM conversion
  - Add error handling for Zod validation in offscreen handlers
  - Post stats during sustained backpressure
  - Use interactive latency hint for realtime mode
  - Handle WebSocket close during handshake gracefully
  - Reject unsupported audio sample rates with clear error

  **Architecture**
  - Extract thaumic-core crate with Sonos client, stream management, and API layer
  - Centralize background task startup and add server IP auto-detection
  - Require explicit runtime handle in bootstrap for predictable initialization

  **Bug Fixes**
  - Align stream URL path with HTTP route
  - Align GENA route with callback URL
  - Use generic SERVICE_ID for health endpoint discovery

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`cbbe631`](https://github.com/brew-lab/thaumic-cast/commit/cbbe6312d28c029d6c8f4bd9d716452e2baf9a60) Thanks [@skezo](https://github.com/skezo)! - Add configurable artwork resolution with precedence chain

  **New Artwork Module (thaumic-core)**
  - Add `ArtworkConfig` and `ArtworkSource` types for flexible artwork configuration
  - Support precedence chain: external HTTPS URL > `data_dir/artwork.jpg` > embedded default
  - External URL option enables Android Sonos app compatibility (requires HTTPS)
  - Single `read()` call with `NotFound` handling avoids TOCTTOU race

  **Server Configuration**
  - Add `artwork_url` config option and `THAUMIC_ARTWORK_URL` env var
  - Document artwork precedence in `config.example.yaml`

  **API Changes**
  - Replace `AppStateBuilder::artwork(&[u8])` with `artwork_config(ArtworkConfig)`
  - Add `AppState::artwork_metadata_url()` for Sonos DIDL-Lite metadata
  - Pass artwork URL through `start_playback()` and `start_playback_multi()`

  **Desktop App**
  - Cache resolved `ArtworkSource` to avoid disk I/O on every playback; URL computed on-demand with current IP/port
  - Support custom artwork via `artwork.jpg` in app data directory

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`19c7e2b`](https://github.com/brew-lab/thaumic-cast/commit/19c7e2b971ceb3595a759ab3068141bdce318812) Thanks [@skezo](https://github.com/skezo)! - Add crossfade on silence transitions to eliminate audio pops

  **Crossfade on Silence Transitions**
  - Apply 2ms linear fade-out when entering silence (audio → silence)
  - Apply 2ms linear fade-in when exiting silence (silence → audio)
  - Track last sample pair for fade-out generation
  - Cap fade samples to available frame size for short frame durations

  **Channel Validation**
  - Reject channel counts other than 1 (mono) or 2 (stereo) in handshake
  - Crossfade utilities require mono/stereo; multi-channel is not supported

  **AudioFormat Helpers**
  - Add `bytes_per_sample()` and `frame_samples()` methods
  - Add `is_crossfade_compatible()` check for 16-bit PCM validation

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`2109faf`](https://github.com/brew-lab/thaumic-cast/commit/2109faf6fa40452a56789ddd08f22ccf08d884bb) Thanks [@skezo](https://github.com/skezo)! - Extract core streaming logic into thaumic-core crate

  **Architectural Refactor**

  Extract the core Sonos streaming logic from the desktop app into a standalone Rust library (`packages/thaumic-core`). This enables:
  - Headless server deployments without Tauri/GUI dependencies
  - Shared code between desktop app and standalone server
  - Cleaner separation of concerns

  **New Abstractions**
  - `EventEmitter` trait: Pluggable event dispatch (Tauri events, WebSocket broadcast, etc.)
  - `Context`: Shared application state with runtime handles
  - `StreamingRuntime`: Dedicated high-priority runtime for audio streaming
  - `bootstrap_services()`: Unified service initialization

  **Modules Migrated**
  - Sonos client, discovery (SSDP/mDNS), GENA subscriptions
  - Stream manager, WAV/ICY formatters, transcoder
  - HTTP API routes, WebSocket handlers
  - All background services (topology monitor, latency monitor, etc.)

  The desktop app now depends on thaumic-core and provides only Tauri-specific glue code.

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`4082c40`](https://github.com/brew-lab/thaumic-cast/commit/4082c40e2b7bef74d4a46d61c7325880a2169ddd) Thanks [@skezo](https://github.com/skezo)! - Improve WAV streaming reliability for Sonos speakers

  **WAV Stream Stability**
  - Inject silence frames during delivery gaps to prevent Sonos disconnection (WAV streams require continuous data flow)
  - Use fixed Content-Length header instead of chunked transfer encoding (some renderers stutter with chunked)
  - Add upfront buffer delay (250ms) before serving audio to reduce early-connection jitter sensitivity
  - Cache silence frames globally to avoid ~200KB/s allocations during delivery gaps
  - Add TransferMode.dlna.org and icy-name headers to all audio streams for DLNA compatibility
  - Elevate process priority to reduce audio stuttering under CPU load (HIGH_PRIORITY_CLASS on Windows, nice -10 on Unix)
  - Enrich DIDL-Lite metadata with audio format attributes (sampleFrequency, nrAudioChannels, bitsPerSample)

  **Epoch Tracking Accuracy**
  - Introduce TaggedFrame enum to distinguish real audio from injected silence
  - Only fire epoch on real audio frames, not silence or empty buffers
  - Reorder subscribe/delay sequence for more accurate timing

  **Race Condition Fixes**
  - Add stream_id to PlaybackStopped event to prevent incorrect session cleanup during recast
  - Stop old playback before starting new stream on same speaker to ensure clean source switching

  **Configuration & Architecture**
  - Extract StreamingConfig struct with validation (max_concurrent_streams, buffer_frames, channel_capacity)
  - Wire streaming config through bootstrap chain for proper dependency injection
  - Add unit tests for StreamingConfig validation and AudioFormat calculations

  **Observability**
  - Add HTTP stream lifecycle logging (start/end, frames sent, delivery gaps)
  - Log frame delivery gap instrumentation (max gap, gaps over threshold)
  - Log broadcast channel lag errors and JSON serialization failures
  - Document TOCTOU mitigation in GENA subscription store

  **Other**
  - Add Windows debug build script
  - Add resolve.dedupe for Windows monorepo compatibility

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`f158fb2`](https://github.com/brew-lab/thaumic-cast/commit/f158fb22a398e1adcac5b344b118a10a9bdcde61) Thanks [@skezo](https://github.com/skezo)! - Preserve Float32 audio throughout pipeline to enable 24-bit FLAC encoding

  **Audio Pipeline Refactor**
  - Keep Float32 samples throughout the audio pipeline (AudioWorklet → ring buffer → encoders) instead of early Int16 quantization
  - Change ring buffer from Int16Array to Float32Array to preserve full precision
  - Move Int16 quantization to PCM encoder as the final step before wire transmission
  - Enable 24-bit FLAC encoding without precision loss from the audio source

  **24-bit FLAC Support**
  - Add `bitsPerSample` field to `EncoderConfig` (16 or 24, default 16)
  - FLAC encoder uses s32-planar format scaled to 24-bit range when configured for 24-bit
  - Validate that 24-bit encoding is only allowed for FLAC codec (Sonos S2 requirement)
  - Extract and verify actual bit depth from FLAC header, warn on mismatch

  **Clipping Detection**
  - Track clipped samples (NaN, values outside [-1, 1]) in PCM processor
  - Report clipping count via heartbeat messages for audio quality diagnostics
  - Replace NaN values with 0 to prevent undefined encoder behavior

  **Encoder Optimizations**
  - Pre-allocate ADTS header buffer in AAC encoder (only bytes 3-6 vary per frame)
  - Reuse output queue array instead of reallocating to reduce GC pressure
  - Add detailed documentation for ADTS header structure and bit field layout

  **WAV Header Updates**
  - Support variable bit depth (16 or 24) in WAV header generation
  - Validate bits_per_sample in WebSocket handshake, reject invalid values
  - Calculate byte_rate and block_align dynamically based on bit depth

### Patch Changes

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`3f07d14`](https://github.com/brew-lab/thaumic-cast/commit/3f07d14365f3798baea4e34c37a42ced545529ad) Thanks [@skezo](https://github.com/skezo)! - Add manual speaker IP management API to standalone server

  **New HTTP Endpoints (thaumic-server)**
  - `POST /api/speakers/manual/probe` - Validate IP and probe for Sonos speaker
  - `POST /api/speakers/manual` - Add manual speaker (probes before persisting)
  - `DELETE /api/speakers/manual/:ip` - Remove manual speaker (with fallback for legacy entries)
  - `GET /api/speakers/manual` - List manual speaker IPs

  **Server Configuration**
  - Add `--data-dir` CLI option and `THAUMIC_DATA_DIR` env var for persistence
  - Add `data_dir` field to config.yaml
  - Return 503 SERVICE_UNAVAILABLE when data_dir not configured

  **Shared Code (thaumic-core)**
  - Add `validate_speaker_ip()` with `IpValidationError` enum
  - Add `ErrorCode` trait implementation for consistent error codes
  - Export `ErrorCode` trait for use by consumers
  - Add `set_app_data_dir(impl AsRef<Path>)` for flexible path passing

  **Desktop Refactoring**
  - Use shared `validate_speaker_ip()` instead of inline validation
  - Import `ErrorCode` trait for IP validation error handling

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`2109faf`](https://github.com/brew-lab/thaumic-cast/commit/2109faf6fa40452a56789ddd08f22ccf08d884bb) Thanks [@skezo](https://github.com/skezo)! - Add collapsible sidebar with intrinsic design
  - Sidebar can now be collapsed to icon-only mode for more content space
  - Collapse state persists across sessions via app store
  - Smooth CSS transitions for expand/collapse animation
  - Icons remain visible and functional in collapsed state
  - Responsive behavior adjusts to container width

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`896fabc`](https://github.com/brew-lab/thaumic-cast/commit/896fabc8df8a5b42ec400c48103ccaada8d2485f) Thanks [@skezo](https://github.com/skezo)! - Improve resilience to CPU spikes during audio streaming
  - Increase broadcast channel capacity from 100 to 500 frames (~10 seconds of buffer instead of ~2 seconds), allowing HTTP clients to absorb longer delivery delays without disconnecting
  - Increase WebSocket heartbeat timeout from 10 to 30 seconds, reducing spurious disconnects during system-wide CPU contention

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`478ab65`](https://github.com/brew-lab/thaumic-cast/commit/478ab650978fe271f8857307b835a4e1b61c5262) Thanks [@skezo](https://github.com/skezo)! - Standardize Card usage and mobile-first responsive design

  **Card Component**
  - Add optional `icon` prop that renders before the title (inherits title color via `currentColor`)
  - Add title text truncation support when Card has icons (flexbox layout with span wrapper)

  **Desktop App**
  - Update views to use Card's `title`/`icon` props instead of custom header styles
  - Convert sidebar and views to mobile-first container queries
  - Align Settings toggle layout with Server action row pattern (h4/p structure)
  - Server status card shows operational state with colored icon

  **Extension**
  - Use shared Input component in onboarding for consistent placeholder styling

  **Shared Styles**
  - Standardize input placeholder opacity (0.7) across apps

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`b03c4ee`](https://github.com/brew-lab/thaumic-cast/commit/b03c4ee54ce8c0590ad57a767c1b9315550b3dc4) Thanks [@skezo](https://github.com/skezo)! - Start minimized to system tray when launched via autostart

  When the app is launched with the `--minimized` flag (automatically passed by the autostart plugin), the main window is now hidden on startup, leaving only the system tray icon visible. On macOS, the dock icon is also hidden in this mode.

  This provides a seamless auto-start experience where the app runs in the background without interrupting the user's workflow.

- Updated dependencies [[`6921795`](https://github.com/brew-lab/thaumic-cast/commit/6921795b559217b5ee5342852e7c59b80fc858d4), [`7629de4`](https://github.com/brew-lab/thaumic-cast/commit/7629de408fa0aad7e2a454726d890fb32df3d6ee), [`a8ee07e`](https://github.com/brew-lab/thaumic-cast/commit/a8ee07e4510f88292c9452d8ead84ac79a3d077a), [`9ee78a4`](https://github.com/brew-lab/thaumic-cast/commit/9ee78a4240e0abe22ddff3765baf18988de2f9b3), [`823bbf7`](https://github.com/brew-lab/thaumic-cast/commit/823bbf7ec9cf517ddf5e1076c195de7e05b8be2b), [`4082c40`](https://github.com/brew-lab/thaumic-cast/commit/4082c40e2b7bef74d4a46d61c7325880a2169ddd), [`f158fb2`](https://github.com/brew-lab/thaumic-cast/commit/f158fb22a398e1adcac5b344b118a10a9bdcde61), [`b2d3b7c`](https://github.com/brew-lab/thaumic-cast/commit/b2d3b7c146d183217d79c04004f775c8dbedf0c8), [`08673ee`](https://github.com/brew-lab/thaumic-cast/commit/08673eee4b0c1916f7e4abb79caa49effcffc4f7), [`2109faf`](https://github.com/brew-lab/thaumic-cast/commit/2109faf6fa40452a56789ddd08f22ccf08d884bb), [`478ab65`](https://github.com/brew-lab/thaumic-cast/commit/478ab650978fe271f8857307b835a4e1b61c5262), [`be4e2d0`](https://github.com/brew-lab/thaumic-cast/commit/be4e2d0c281f8f3ec0cb24cbe00bec55c97808d9)]:
  - @thaumic-cast/protocol@0.2.0
  - @thaumic-cast/ui@1.0.0

## 0.9.0

### Minor Changes

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`0bb42f7`](https://github.com/brew-lab/thaumic-cast/commit/0bb42f7d38b93fbb523c87978ef8de066d357b12) Thanks [@skezo](https://github.com/skezo)! - Add manual speaker IP entry for networks where discovery fails
  - Users can manually enter Sonos speaker IP addresses when SSDP/mDNS discovery fails (VPNs, firewalls, network segmentation)
  - IPs are probed to verify they're valid Sonos devices before being saved
  - Manual speakers are merged with auto-discovered speakers during topology refresh
  - Added Input component to shared UI package
  - Manual entry available in onboarding SpeakerStep and Settings view

### Patch Changes

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`5943fa0`](https://github.com/brew-lab/thaumic-cast/commit/5943fa0c896b0b6fce4b3c1d25f4cfa435f17a00) Thanks [@skezo](https://github.com/skezo)! - Convert CSS module classes from camelCase to kebab-case
  - Updated all CSS module class selectors to use kebab-case naming convention
  - Updated corresponding TSX imports to use bracket notation for kebab-case properties
  - Enforced by new stylelint selector-class-pattern rule

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`da980ad`](https://github.com/brew-lab/thaumic-cast/commit/da980ad6a4baf8215e41379f190c252e9b1b9e8b) Thanks [@skezo](https://github.com/skezo)! - Debounce speaker list updates to reduce UI churn
  - Coalesce rapid event bursts (multi-speaker start/stop) into single fetch
  - Reduces API calls from 20+ to 5 during typical multi-speaker operations
  - 150ms debounce window balances responsiveness with efficiency

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`b91f86f`](https://github.com/brew-lab/thaumic-cast/commit/b91f86f3490c0343f454c76eefb4ea6a51ca8ca2) Thanks [@skezo](https://github.com/skezo)! - Use bounded channel for internal GENA events to prevent unbounded memory growth
  - Replaced unbounded channel with bounded channel (capacity 64)
  - Events are dropped with a warning if channel fills (safe since all trigger same recovery)
  - Prevents theoretical memory growth if receiver stalls during event spikes

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`37da618`](https://github.com/brew-lab/thaumic-cast/commit/37da618baaa04c4a314847e6862e026fd9b409ae) Thanks [@skezo](https://github.com/skezo)! - Optimize ICY metadata injection hot path
  - Cache formatted metadata to avoid repeated allocations when metadata unchanged
  - Pre-size output buffers based on expected metadata insertions
  - Lower per-block logging from info to trace level

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`9c37879`](https://github.com/brew-lab/thaumic-cast/commit/9c37879504d915177e9f0c955cb522b353308256) Thanks [@skezo](https://github.com/skezo)! - Reuse scratch buffer in ICY metadata injection to reduce allocation pressure
  - Replace per-chunk Vec allocation with reusable BytesMut buffer
  - Buffer grows to typical chunk size and stabilizes after a few calls
  - Reduces allocator churn on long audio streams

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`e188cd6`](https://github.com/brew-lab/thaumic-cast/commit/e188cd61c44d7f20de9520b8630efbb07be28789) Thanks [@skezo](https://github.com/skezo)! - Use tokio interval instead of sleep for timer loops
  - Reduces timer allocation overhead in WebSocket heartbeat and latency polling
  - Prevents timing drift by compensating for processing time

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`5e94ffd`](https://github.com/brew-lab/thaumic-cast/commit/5e94ffd4d5570e3bd2c7c65ff067c799b18a7712) Thanks [@skezo](https://github.com/skezo)! - Eliminate unnecessary memory copy for passthrough audio streams
  - Changed Transcoder trait to accept `Bytes` instead of `&[u8]`
  - Passthrough now returns input directly without copying
  - Removes ~100 memcpys/second for pre-encoded streams (AAC, FLAC, Vorbis)

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`3743c52`](https://github.com/brew-lab/thaumic-cast/commit/3743c520b35b115c246b6084cb57e20f0d4620d5) Thanks [@skezo](https://github.com/skezo)! - Fix latency session leak when WebSocket handler exits unexpectedly
  - Prune orphaned sessions during poll loop when stream no longer exists
  - Prevents sessions from being polled indefinitely after unexpected disconnects
  - Defense-in-depth cleanup for StreamGuard::drop edge cases

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`add7dd6`](https://github.com/brew-lab/thaumic-cast/commit/add7dd6abbc00b8e655352c64bbc42b1139252e1) Thanks [@skezo](https://github.com/skezo)! - Use allocation-free ASCII case-insensitive parsing for SSDP responses
  - Eliminates multiple string allocations per response during discovery burst
  - Uses byte-level comparison instead of to_lowercase()
  - Improves discovery performance on networks with many speakers

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`b166791`](https://github.com/brew-lab/thaumic-cast/commit/b1667915c0110df2809fe95cfd3028a8636024ba) Thanks [@skezo](https://github.com/skezo)! - Add theme-aware tray icons on Windows
  - Tray icon now adapts to Windows light/dark mode with 4 icon variants (light/dark x idle/active)
  - Icon updates automatically when system theme changes
  - macOS continues to use template icons for native theme adaptation

- Updated dependencies [[`5943fa0`](https://github.com/brew-lab/thaumic-cast/commit/5943fa0c896b0b6fce4b3c1d25f4cfa435f17a00), [`8375f3a`](https://github.com/brew-lab/thaumic-cast/commit/8375f3a50b11df70d428d52a451141257c0b3123), [`0bb42f7`](https://github.com/brew-lab/thaumic-cast/commit/0bb42f7d38b93fbb523c87978ef8de066d357b12), [`070afca`](https://github.com/brew-lab/thaumic-cast/commit/070afca65cc5c323aa0cc2e57117be1e846d04ed)]:
  - @thaumic-cast/ui@0.1.0

## 0.8.4

### Patch Changes

- [#33](https://github.com/brew-lab/thaumic-cast/pull/33) [`a15f0f9`](https://github.com/brew-lab/thaumic-cast/commit/a15f0f9f028a36efcdf66e6c91c3545cc43473d2) Thanks [@skezo](https://github.com/skezo)! - ### Improvements
  - **System Tray**: Add macOS template icons that automatically adapt to light/dark menu bar. The tray icon now switches between idle and active states based on streaming activity.

## 0.8.3

### Patch Changes

- [#32](https://github.com/brew-lab/thaumic-cast/pull/32) [`06490c3`](https://github.com/brew-lab/thaumic-cast/commit/06490c3aebf5c2f9d81b87932001ca9f5f400d8b) Thanks [@skezo](https://github.com/skezo)! - ### Bug Fixes
  - **Speaker Discovery**: Fix race condition where initial scan could miss speakers if discovery completed before the listener was registered. Now fetches existing groups immediately on mount.
  - **Playback Reliability**: Add retry logic with exponential backoff (200ms, 500ms, 1s) for transient SOAP errors (701, 714, 716) when starting playback. Previously, busy speakers would fail immediately requiring manual retry.
  - **GENA Subscriptions**: Only subscribe to coordinators for AVTransport. Satellites (Sub, surrounds) and bridges (Boost) don't support AVTransport and were returning 503 errors.

  ### Code Quality
  - Extract shared Tauri event payload types (`DiscoveryCompletePayload`, `NetworkHealthPayload`, `TransportStatePayload`) to `lib/events.ts`
  - Add `listenOnce` utility for one-shot event listening with timeout fallback
  - Add `SoapError::is_transient()` method to identify retryable errors
  - Add `with_retry` helper for SOAP operations with exponential backoff
  - Consolidate GENA subscription sync/cleanup functions for coordinators

- [#32](https://github.com/brew-lab/thaumic-cast/pull/32) [`7848217`](https://github.com/brew-lab/thaumic-cast/commit/784821772da8e0b1501653cd680f157d881b0a0e) Thanks [@skezo](https://github.com/skezo)! - ### Documentation
  - **Onboarding Firewall Step**: Update copy to explain mDNS multicast addresses (224._) that may appear in third-party firewalls like Little Snitch. Users were confused when seeing connections to unfamiliar 224._ addresses during speaker discovery.

- Updated dependencies [[`f633dda`](https://github.com/brew-lab/thaumic-cast/commit/f633dda4f4146a81a908c14a6b79dfc44ca6f674)]:
  - @thaumic-cast/ui@0.0.5

## 0.8.2

### Patch Changes

- Updated dependencies [[`21e4991`](https://github.com/brew-lab/thaumic-cast/commit/21e4991c5769c6d50b7cff677d05245fb6021afa)]:
  - @thaumic-cast/ui@0.0.4

## 0.8.1

### Patch Changes

- Updated dependencies [[`7af7ee1`](https://github.com/brew-lab/thaumic-cast/commit/7af7ee150acabc9812cf74bd8d1c9edd1e8edded)]:
  - @thaumic-cast/ui@0.0.3

## 0.8.0

## 0.7.0

### Minor Changes

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`ea2ed2f`](https://github.com/brew-lab/thaumic-cast/commit/ea2ed2f2102cdddd26216c963e4c0470a49c5605) Thanks [@skezo](https://github.com/skezo)! - Add multi-method Sonos speaker discovery for improved reliability
  - SSDP multicast (standard 239.255.255.250:1900)
  - SSDP broadcast (directed per-interface + 255.255.255.255 fallback)
  - mDNS/Bonjour (\_sonos.\_tcp.local.)

  All methods run in parallel and results are merged with comprehensive UUID normalization. This helps discover speakers on networks where multicast is blocked but mDNS works (common on macOS with firewall enabled).

### Patch Changes

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`01f2d22`](https://github.com/brew-lab/thaumic-cast/commit/01f2d22d14ef1a71f3b3a5c63eba10c1d67b7e4b) Thanks [@skezo](https://github.com/skezo)! - Add epoch-based latency measurement for video sync
  - Per-speaker playback epochs anchored to oldest prefill frame served
  - Emit `epochId` and `jitterMs` in latency events for extension state machine
  - Add `LatencyEvent::Stale` when no valid position data for 30s
  - TTL cleanup for epoch HashMap (max 20 entries per stream)

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`ec40759`](https://github.com/brew-lab/thaumic-cast/commit/ec407595bbf3424b3a2595f3124a49efcc05bbc1) Thanks [@skezo](https://github.com/skezo)! - Fix speaker discovery UI showing "No speakers found" prematurely during onboarding by using event-driven updates instead of timer-based polling

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`0d2d1d8`](https://github.com/brew-lab/thaumic-cast/commit/0d2d1d8a313f187bbe833ffbce710c67966aed8e) Thanks [@skezo](https://github.com/skezo)! - Add event-driven UI updates for network health and stream status, replacing polling with real-time Tauri events for more responsive speaker discovery and playback status

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`66883af`](https://github.com/brew-lab/thaumic-cast/commit/66883afd06379cec28fe6115aad8aa246a11f73c) Thanks [@skezo](https://github.com/skezo)! - Fix "launch at login" setting not persisting after app restart

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`e9d78dc`](https://github.com/brew-lab/thaumic-cast/commit/e9d78dc06f2f9c247ca904702fb29edb41039cdb) Thanks [@skezo](https://github.com/skezo)! - Fix macOS dock icon persisting after window is closed

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`bf687a6`](https://github.com/brew-lab/thaumic-cast/commit/bf687a6ad1f2b8110555f077f14b15fb0f33376b) Thanks [@skezo](https://github.com/skezo)! - Fix WAV/PCM stream stop timeout by closing HTTP connections before sending SOAP commands to Sonos

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`098bc11`](https://github.com/brew-lab/thaumic-cast/commit/098bc112946bc3a769e12ac76b2fab049a635e02) Thanks [@skezo](https://github.com/skezo)! - Redesign system tray menu with quick actions and status
  - Display app name with version and streaming status
  - Add Dashboard action to open the main window
  - Add Launch at Startup toggle for autostart control
  - Add Stop All Streams and Restart Server quick actions
  - Full i18n support with localized menu items

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`bf865cb`](https://github.com/brew-lab/thaumic-cast/commit/bf865cb344755388f2a2b7054728c9e6a5d1714b) Thanks [@skezo](https://github.com/skezo)! - Use platform-specific terminology in onboarding welcome step (menu bar on macOS, system tray on Windows/Linux)

- Updated dependencies [[`afbe950`](https://github.com/brew-lab/thaumic-cast/commit/afbe95005caa9dea84483d1fea0fe0c93e65e714)]:
  - @thaumic-cast/ui@0.0.2
  - @thaumic-cast/protocol@0.1.1

## 0.6.1

### Patch Changes

- [#19](https://github.com/brew-lab/thaumic-cast/pull/19) [`aae78f0`](https://github.com/brew-lab/thaumic-cast/commit/aae78f008ec7a019c8f312db9c288e34462e1a99) Thanks [@skezo](https://github.com/skezo)! - fix(desktop): resolve macOS "damaged app" error with ad-hoc signing
  - Add explicit ad-hoc signing identity for macOS builds
  - Set minimum macOS version to 12.0 (Monterey)
  - Add bundle metadata (category, copyright, publisher, description)

## 0.6.0

### Minor Changes

- [#17](https://github.com/brew-lab/thaumic-cast/pull/17) [`06ffe4f`](https://github.com/brew-lab/thaumic-cast/commit/06ffe4f80c6837314941d1e47115143f3bd44d2d) Thanks [@skezo](https://github.com/skezo)! - Add latency monitoring service for measuring audio playback delay
  - Add GetPositionInfo SOAP call to query Sonos playback position
  - Track stream timing via sample count for precise source position
  - Create LatencyMonitor service with high-frequency polling (100ms)
  - Calculate latency with RTT compensation and EMA smoothing
  - Emit LatencyEvent broadcasts with confidence scoring
  - Foundation for future video-to-audio sync feature

- [#17](https://github.com/brew-lab/thaumic-cast/pull/17) [`cf0b867`](https://github.com/brew-lab/thaumic-cast/commit/cf0b867942b54fd1f099d1bc031ebe1cc5f2b860) Thanks [@skezo](https://github.com/skezo)! - Add server-side WAV encoding for lossless audio streaming
  - Add "Lossless (WAV)" codec option that sends raw PCM from browser to desktop app
  - Desktop app wraps PCM in WAV container for true lossless quality
  - Works universally since PCM passthrough has no browser codec dependencies
  - Hide bitrate selector in UI for lossless codecs (no bitrate options)

### Patch Changes

- [#17](https://github.com/brew-lab/thaumic-cast/pull/17) [`ca0081e`](https://github.com/brew-lab/thaumic-cast/commit/ca0081ef4ceaaad2d3cced16a29be293bcc01e8b) Thanks [@skezo](https://github.com/skezo)! - Improve UI polish with themed scrollbars and better typography
  - Add thin themed scrollbars using `scrollbar-width: thin` and `scrollbar-color` with the primary color for a consistent, subtle appearance
  - Apply `text-wrap: balance` to headings and `text-wrap: pretty` to paragraphs for improved text layout

- Updated dependencies [[`06ffe4f`](https://github.com/brew-lab/thaumic-cast/commit/06ffe4f80c6837314941d1e47115143f3bd44d2d)]:
  - @thaumic-cast/protocol@0.1.0

## 0.5.0

### Minor Changes

- [#15](https://github.com/brew-lab/thaumic-cast/pull/15) [`f65dae0`](https://github.com/brew-lab/thaumic-cast/commit/f65dae0711e26bf2682b604474125b70dc28820e) Thanks [@skezo](https://github.com/skezo)! - ### Theme System
  - Add dark/light mode support with automatic system preference detection
  - Adopt mystical violet OKLCH color palette with semantic token layers
  - Add motion tokens with reduced-motion support

  ### Internationalization
  - Add i18n framework with English translations for desktop and extension
  - Detect system/browser language preferences automatically

  ### Multi-Group Casting
  - Add UI to select and cast to multiple Sonos speaker groups simultaneously

  ### Onboarding
  - Add first-time user onboarding wizard with platform-specific firewall instructions
  - Defer network services until firewall warning is acknowledged

  ### Network Health Monitoring
  - Detect VPN/network issues that prevent speaker communication
  - Show contextual warnings when speakers aren't responding
  - Improve error messaging for no-speakers-found state

  ### ActiveCastCard Redesign
  - Redesign with artwork background and dynamic color extraction
  - Add playback controls (play/pause, stop)
  - Add view transitions for track changes
  - Make title clickable to navigate to source tab

  ### Shared UI Components
  - Add VolumeControl with fill indicator and mute button
  - Add IconButton component
  - Add Alert component with error/warning/info variants and dismiss support

  ### Accessibility
  - Improve WCAG 2.1 AA compliance across extension UI
  - Ensure proper contrast ratios for all text elements

  ### Fixes
  - Stop speakers immediately when stream ends
  - Switch speakers to queue after stopping stream
  - Clean up existing stream when starting playback on same speaker
  - Sync transport state for stream recovery
  - Reconnect when server settings change
  - Use static branding in DIDL-Lite metadata

## 0.4.1

## 0.4.0

## 0.3.1

### Patch Changes

- [#9](https://github.com/brew-lab/thaumic-cast/pull/9) [`9751058`](https://github.com/brew-lab/thaumic-cast/commit/9751058c2b06c0e40d48e3b0aecd5cfe410be3e5) Thanks [@skezo](https://github.com/skezo)! - Fix automated release workflow
  - Change changesets config from `linked` to `fixed` to ensure both packages always version together
  - Add version mismatch detection in release-pr workflow
  - Fix missing Linux build dependencies in release workflow
  - Add `tauriScript` config for bun in tauri-action
  - Use `workflow_call` to trigger release builds automatically (no PAT required)

## 0.3.0

### Minor Changes

- [#7](https://github.com/brew-lab/thaumic-cast/pull/7) [`b354fbf`](https://github.com/brew-lab/thaumic-cast/commit/b354fbfcf4b7611042611fafa6f91d747034c321) Thanks [@skezo](https://github.com/skezo)! - Add native power state detection and battery-aware audio config
  - Desktop app now detects system power state using native OS APIs (starship-battery)
  - Power state is sent to extension via WebSocket, bypassing browser Battery API limitations
  - Extension automatically selects lower-quality audio config when on battery to prevent audio dropouts
  - Added audio pipeline monitoring to detect silent failures and source starvation
  - Session health tracking reports audio drops for config learning

## 0.1.1

### Patch Changes

- [#2](https://github.com/brew-lab/thaumic-cast/pull/2) [`e9169f5`](https://github.com/brew-lab/thaumic-cast/commit/e9169f5094b25262f7f376b82954d46160ca9f40) Thanks [@skezo](https://github.com/skezo)! - Fix runtime errors and audio streaming issues
  - Fix nested anchor tags in Sidebar causing "improper nesting of interactive content" warnings
  - Fix TypeScript types to match Rust backend ZoneGroup structure
  - Fix undefined coordinator access causing infinite re-render loop
  - Fix AudioWorkletNode not connected to audio graph, preventing audio capture
  - Fix codec mismatch in WebSocket handshake causing wrong Content-Type for Sonos
  - Fix XML escaping in SOAP/DIDL to escape all 5 XML special characters (was missing " and ')
