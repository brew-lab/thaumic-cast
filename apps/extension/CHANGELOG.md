# @thaumic-cast/extension

## 0.12.0

### Minor Changes

- [#68](https://github.com/brew-lab/thaumic-cast/pull/68) [`a7d3d23`](https://github.com/brew-lab/thaumic-cast/commit/a7d3d23ea2fe6bc5deae53cb905751a38fc5559e) Thanks [@skezo](https://github.com/skezo)! - Add bi-directional playback control between extension and Sonos

  When casting, playback state now syncs in both directions:
  - **Sonos → Browser**: Pause/play on Sonos remote or app controls the browser tab
  - **Browser → Sonos**: Play in browser (YouTube controls, keyboard shortcuts) resumes Sonos

  Technical improvements:
  - Use per-speaker epoch tracking for accurate resume detection
  - Delegate playback decisions to server for consistent state handling
  - Send Play command unless speaker is definitively playing (handles cache misses)
  - Deduplicate Play commands on PCM resume to prevent audio glitches
  - Add error handling for broker failures during playback notifications

- [#71](https://github.com/brew-lab/thaumic-cast/pull/71) [`a01a1c4`](https://github.com/brew-lab/thaumic-cast/commit/a01a1c4bd61ff52bddb5d244ca8361fd0a127351) Thanks [@skezo](https://github.com/skezo)! - Add fixed volume detection for Sonos speakers with line-level output

  Sonos devices like CONNECT and Port have fixed line-level output where volume cannot be adjusted via API. This change detects and handles these speakers:
  - Parse `OutputFixed` from GENA GroupRenderingControl notifications
  - Propagate `fixed` state through the event system alongside volume updates
  - Disable volume controls in the UI for fixed-output speakers
  - Add `disabled` prop to `VolumeControl` and `SpeakerVolumeRow` components

  When a speaker has fixed volume, the volume slider and mute button are visually disabled and non-interactive.

### Patch Changes

- [#70](https://github.com/brew-lab/thaumic-cast/pull/70) [`48c068f`](https://github.com/brew-lab/thaumic-cast/commit/48c068f1fd3751fa6796997229692167913ba68a) Thanks [@skezo](https://github.com/skezo)! - Refactor connection status handling for better separation of concerns

  **Extension changes:**
  - Refactor `useConnectionStatus` hook to use reducer pattern for explicit state transitions
  - Remove i18n translation from hook; return error keys for component-level translation
  - Separate `WS_STATE_CHANGED` to only carry Sonos state (not connection metadata)
  - Add `CONNECTION_ATTEMPT_FAILED` message for explicit connection error handling
  - Replace `connected`/`checking` booleans with `phase` enum (`checking`, `reconnecting`, `connected`, `error`)
  - Add `canRetry` flag and `retry()` function to connection status
  - Add reconnecting state with user feedback when connection is temporarily lost
  - Fix race condition where WebSocket connects before `ENSURE_CONNECTION` response arrives

  **UI changes:**
  - Add inline action button support to Alert component (`action` and `onAction` props)

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

- Updated dependencies [[`48c068f`](https://github.com/brew-lab/thaumic-cast/commit/48c068f1fd3751fa6796997229692167913ba68a), [`77a19e2`](https://github.com/brew-lab/thaumic-cast/commit/77a19e21150e6b7cd35af44fb3bd6d47edc4d636), [`a01a1c4`](https://github.com/brew-lab/thaumic-cast/commit/a01a1c4bd61ff52bddb5d244ca8361fd0a127351), [`f958485`](https://github.com/brew-lab/thaumic-cast/commit/f9584852e7e2649435ff231d01352195c65c59d9)]:
  - @thaumic-cast/ui@3.0.0
  - @thaumic-cast/protocol@0.4.0

## 0.11.0

### Minor Changes

- [#64](https://github.com/brew-lab/thaumic-cast/pull/64) [`36b0c9f`](https://github.com/brew-lab/thaumic-cast/commit/36b0c9fe5af688a692756eb3f066b494d0ae8441) Thanks [@skezo](https://github.com/skezo)! - Add partial speaker removal for multi-group casts
  - Add per-speaker remove button (X) to ActiveCastCard, shown only when 2+ speakers
  - Send STOP_PLAYBACK_SPEAKER command to remove individual speakers without stopping entire cast
  - Track user-initiated vs system removals for accurate analytics (user_removed reason)
  - Stop latency monitoring when a speaker is removed
  - Add translations for user_removed auto-stop reason
  - Sort speakers alphabetically for consistent UI ordering (extension and desktop)

  UX improvements:
  - Add 48px touch target to volume slider for better accessibility (WCAG 2.5.5)
  - Add CSS tokens for slider dimensions, touch target size, and muted state opacity
  - Disable text selection on interactive controls (volume, speaker rows, popup header/footer)
  - Allow text selection only on track info sections (title, subtitle)
  - Use semantic CSS tokens for disabled/muted opacity states

### Patch Changes

- [#59](https://github.com/brew-lab/thaumic-cast/pull/59) [`6ab489e`](https://github.com/brew-lab/thaumic-cast/commit/6ab489e2b6857ce5b22618bd07509dd6a2ecb06b) Thanks [@skezo](https://github.com/skezo)! - fix(extension): improve server URL settings behavior
  - Sync URL input with settings when changed externally
  - Auto-save and test server URL on blur (skip if clicking test button)
  - Allow clearing server URL by emptying the input
  - Normalize UI state on load: if manual mode has no URL, show auto-discover (not persisted to avoid storage listener triggers during editing)

- [#51](https://github.com/brew-lab/thaumic-cast/pull/51) [`0a194c2`](https://github.com/brew-lab/thaumic-cast/commit/0a194c21329e7b4acdbb517133d82a21340d5bf3) Thanks [@skezo](https://github.com/skezo)! - Bump JavaScript and Rust dependencies

- [#65](https://github.com/brew-lab/thaumic-cast/pull/65) [`5532946`](https://github.com/brew-lab/thaumic-cast/commit/553294669c6a086a134546e888eba9475469f32a) Thanks [@skezo](https://github.com/skezo)! - Replace `tabs` permission with `activeTab` for minimal permission footprint

- Updated dependencies [[`94102c1`](https://github.com/brew-lab/thaumic-cast/commit/94102c1444f01b81c23e43ae4c56c731d71579c3), [`36b0c9f`](https://github.com/brew-lab/thaumic-cast/commit/36b0c9fe5af688a692756eb3f066b494d0ae8441), [`3a12f9a`](https://github.com/brew-lab/thaumic-cast/commit/3a12f9aea098aeda38ee956827bb837ce7304e07)]:
  - @thaumic-cast/ui@2.0.0
  - @thaumic-cast/protocol@0.3.0

## 0.10.4

### Patch Changes

- [#49](https://github.com/brew-lab/thaumic-cast/pull/49) [`f8824d1`](https://github.com/brew-lab/thaumic-cast/commit/f8824d1dbc5bdef26a6e693dda4b002d910bc133) Thanks [@skezo](https://github.com/skezo)! - Fix service ID check to match thaumic-core constant

## 0.10.3

## 0.10.2

### Patch Changes

- [#45](https://github.com/brew-lab/thaumic-cast/pull/45) [`5f08652`](https://github.com/brew-lab/thaumic-cast/commit/5f08652d8d7641ca7a51e2419e9d2867742a2a21) Thanks [@skezo](https://github.com/skezo)! - Fix desktop app download URL in onboarding to point to the correct GitHub releases page.

## 0.10.1

### Patch Changes

- [#43](https://github.com/brew-lab/thaumic-cast/pull/43) [`67708d1`](https://github.com/brew-lab/thaumic-cast/commit/67708d130418f63b69e64ca6ed2d6c5d37af09ba) Thanks [@skezo](https://github.com/skezo)! - Migrate extension settings from sync to local storage and add privacy policy
  - Switch from `chrome.storage.sync` to `chrome.storage.local` for all extension settings
  - Add one-time migration to preserve existing user settings
  - Add PRIVACY.md documenting data handling practices

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

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`a8ee07e`](https://github.com/brew-lab/thaumic-cast/commit/a8ee07e4510f88292c9452d8ead84ac79a3d077a) Thanks [@skezo](https://github.com/skezo)! - feat(extension): add bit depth selection to audio settings

  **Protocol:**
  - Add `supportedBitDepths` field to `CodecMetadata` interface for data-driven bit depth validation
  - Add `getSupportedBitDepths()` and `isValidBitDepthForCodec()` helper functions
  - Update schema refinement and `createEncoderConfig()` to use codec metadata instead of hardcoding FLAC checks

  **Extension Settings:**
  - Add `bitsPerSample` field to `CustomAudioSettings` schema with Zod validation
  - Fix `saveExtensionSettings` to deep merge `customAudioSettings` preserving all fields
  - Return Zod-validated settings from `saveExtensionSettings` to ensure React state has defaults applied
  - Fix settings hook to use returned validated settings instead of shallow merge

  **UI:**
  - Add bit depth dropdown in custom mode showing available options per codec (16-bit for most, 16/24-bit for FLAC)
  - Add bit depth row to "What You're Getting" display for all presets
  - Add streaming buffer row to "What You're Getting" display for PCM codec
  - Refactor resolved settings display to data-driven approach for maintainability

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`9ee78a4`](https://github.com/brew-lab/thaumic-cast/commit/9ee78a4240e0abe22ddff3765baf18988de2f9b3) Thanks [@skezo](https://github.com/skezo)! - Use codec-aware frame sizes for optimal encoder efficiency

  **Frame sizes by codec:**
  - AAC: 1024 samples (spec-mandated per ISO/IEC 14496-3)
  - FLAC: 4096 samples (~85ms at 48kHz, larger frames improve compression)
  - Vorbis: 2048 samples (~42.7ms at 48kHz, good VBR balance)
  - PCM: 10ms worth of samples (low latency)

  **Protocol changes:**
  - Added `frameDurationMs` field to `EncoderConfig` schema
  - Added `FRAME_DURATION_MS_MIN` (5ms), `FRAME_DURATION_MS_MAX` (150ms), `FRAME_DURATION_MS_DEFAULT` (10ms) constants
  - Frame duration now sent to server in handshake for proper cadence timing

  **Why 150ms max?**
  - AAC at 8kHz requires 128ms frames (1024 samples is spec-mandated)
  - FLAC benefits from 85ms frames at 48kHz for better compression

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`823bbf7`](https://github.com/brew-lab/thaumic-cast/commit/823bbf7ec9cf517ddf5e1076c195de7e05b8be2b) Thanks [@skezo](https://github.com/skezo)! - Add configurable frame duration setting for PCM streaming
  - Add `frameDurationMs` field to encoder config (10ms, 20ms, or 40ms)
  - Expose Frame Duration dropdown in extension Audio settings (PCM only)
  - Display frame duration in "What You're Getting" resolved settings
  - Default remains 10ms for low latency; larger values improve stability on slow networks
  - Field named generically for future extension to other codecs

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`9f57b44`](https://github.com/brew-lab/thaumic-cast/commit/9f57b44694cae0e10b6ff87ef544d462537fb3e2) Thanks [@skezo](https://github.com/skezo)! - Add extension-side ramp when underflow happens before sending PCM

  **Underflow Ramp-Down**
  - Detect underflow via `Atomics.waitAsync` timeout (200ms)
  - Capture last samples from partial frame buffer for continuity
  - Apply 3ms linear fade-out from last amplitude to silence
  - Fill remainder of frame with zeros before encoding

  **Resume Ramp-In**
  - Track `needsRampIn` flag when underflow occurs
  - Apply 3ms linear fade-in on first frame after resume
  - Only clear flag if ramp was actually applied (guards edge cases)

  **Implementation**
  - Shared `applyRamp()` utility for both fade-in and fade-out (DRY)
  - Reusable `lastSamples` buffer to avoid allocation on underflow
  - Frame-based ramp math ensures all channels get identical gain
  - Proper interpolation: fade-in starts at 0, fade-out starts at 1

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

- [#39](https://github.com/brew-lab/thaumic-cast/pull/39) [`b2d3b7c`](https://github.com/brew-lab/thaumic-cast/commit/b2d3b7c146d183217d79c04004f775c8dbedf0c8) Thanks [@skezo](https://github.com/skezo)! - Add frame queue for quality mode backpressure decoupling

  **Problem**

  In quality mode, WebSocket backpressure would pause the entire consume loop, blocking ring buffer draining. This caused the ring buffer to fill up, leading to producer drops and audible clicks when playback resumed.

  **Solution**

  Replace pause-based backpressure handling with a bounded frame queue that decouples WebSocket backpressure from ring buffer draining:
  - Queue up to 8MB (~30 seconds) of encoded frames during WebSocket backpressure
  - Continue draining ring buffer and encoding even when WebSocket is slow
  - Only block on encoder backpressure (unavoidable bottleneck)

  **Frame Queue Management**
  - Hysteresis at 67% prevents oscillation when trimming overflow
  - O(n) splice operations instead of O(n²) shift loops
  - Flush all queued frames on cleanup to avoid data loss
  - Track queue size, bytes, and overflow drops in stats

  **Producer Drop Detection**
  - Monitor `CTRL_DROPPED_SAMPLES` for worklet-side drops
  - Apply fade-in ramp on first frame after producer drops
  - Unified with existing underflow ramp logic (single `needsRampIn` flag)

  **Type Safety**
  - New `worker-messages.ts` with shared `WorkerInboundMessage` / `WorkerOutboundMessage` types
  - Proper typing for worker↔session communication

  **Protocol Changes**
  - Add `FRAME_QUEUE_HYSTERESIS_RATIO` constant (0.67)
  - Remove unused `wsBufferResumeThreshold` from `StreamingPolicy`

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`2109faf`](https://github.com/brew-lab/thaumic-cast/commit/2109faf6fa40452a56789ddd08f22ccf08d884bb) Thanks [@skezo](https://github.com/skezo)! - Add quality-first streaming policy for audio

  **StreamingPolicy Abstraction**

  Introduce `StreamingPolicy` that derives buffer sizing, drop thresholds, and backpressure behavior from `latencyMode`. This provides a single source of truth for all tunable constants in the audio streaming pipeline.

  **Quality Mode (music, podcasts)**
  - 10-second ring buffer for maximum jitter absorption
  - No catch-up mechanism - buffer can grow freely
  - Pause on backpressure instead of dropping frames
  - 500ms server streaming buffer for stability
  - Eliminates clicks/pops during music streaming to Sonos

  **Realtime Mode (video sync, low-latency)**
  - 3-second ring buffer for bounded memory
  - Catch-up when >1s behind, targeting 200ms
  - Drop frames on backpressure to maintain timing
  - 200ms server streaming buffer for lower latency

  Custom `streamingBufferMs` in settings still overrides policy defaults.

### Patch Changes

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`7629de4`](https://github.com/brew-lab/thaumic-cast/commit/7629de408fa0aad7e2a454726d890fb32df3d6ee) Thanks [@skezo](https://github.com/skezo)! - Add TPDF dithering to audio quantization

  Apply Triangular Probability Density Function (TPDF) dithering when quantizing Float32 samples to integer formats. This decorrelates quantization error from the signal, converting audible harmonic distortion into inaudible white noise floor.

  **Changes**
  - Add `tpdfDither()` utility function to protocol package
  - Apply dithering in PCM encoder (Float32 → Int16)
  - Apply dithering in FLAC encoder 24-bit path (Float32 → Int24)

  Improves audio quality especially in quiet passages, fade-outs, and music with wide dynamic range.

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`2eb1aae`](https://github.com/brew-lab/thaumic-cast/commit/2eb1aaec212dc248b6a93f35742881931a95832a) Thanks [@skezo](https://github.com/skezo)! - Optimize production performance by eliminating debug-only overhead
  - Add `__DEBUG_AUDIO__` build-time flag for audio diagnostics (enabled in dev, eliminated in prod)
  - Guard per-sample clipping detection with build flag, removing ~192k/sec overhead in production
  - Increase stats posting interval from 1s to 2s to reduce message-passing load on low-end devices

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

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`0057163`](https://github.com/brew-lab/thaumic-cast/commit/0057163d79b4cad8602098c75515532e1989e201) Thanks [@skezo](https://github.com/skezo)! - Pre-allocate PCM processor conversion buffer to eliminate real-time audio thread allocations
  - Move conversionBuffer allocation from process() to constructor
  - Size buffer for maximum case (128 samples × 2 channels = 256 floats)
  - Eliminates potential GC-induced audio glitches on low-end devices

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

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`87ce14a`](https://github.com/brew-lab/thaumic-cast/commit/87ce14a5d9de306b9b61f734da65070ae7122549) Thanks [@skezo](https://github.com/skezo)! - Improve audio pipeline timing with performance.now()-based rate control
  - Add time-based frame pacing to produce frames at ~20ms intervals instead of burst processing
  - Replace frame-count based draining with time-budget based approach (~4ms per wake cycle) to avoid setTimeout timer coalescing issues
  - Check backpressure per-frame instead of per-wake for finer-grained flow control
  - Allow burst catch-up of ~3 frames when recovering from brief stalls, with drift clamping to prevent unbounded catch-up

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`0b1764e`](https://github.com/brew-lab/thaumic-cast/commit/0b1764e7341741be4f92f407fe249f284395f1a0) Thanks [@skezo](https://github.com/skezo)! - Optimize PCM processor clamping loop with 4x unrolling
  - Unroll sample clamping loop by 4 for better instruction-level parallelism
  - Replace ternary chain with Math.max/min for JIT-friendly clamping
  - Use `s || 0` pattern for branchless NaN-to-zero conversion
  - Remove unused clippedSampleCount debug instrumentation

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`be4e2d0`](https://github.com/brew-lab/thaumic-cast/commit/be4e2d0c281f8f3ec0cb24cbe00bec55c97808d9) Thanks [@skezo](https://github.com/skezo)! - refactor: make Zod the single source of truth for message types

  **Extension Message Schemas (`message-schemas.ts`):**
  - Add ~50 Zod schemas for all extension message types
  - All types now derived via `z.infer<>` instead of manual interface definitions
  - Add schemas for: cast messages, metadata messages, connection messages, WebSocket messages, state updates, control commands, video sync messages

  **Extension Messages (`messages.ts`):**
  - Remove all manual interface definitions (reduced from 806 to 429 lines)
  - Re-export all types and schemas from `message-schemas.ts`
  - Keep only directional union types (`PopupToBackgroundMessage`, `BackgroundToOffscreenMessage`, etc.)

  **Protocol WebSocket (`websocket.ts`):**
  - Convert `WsControlCommand` from manual type union to `WsControlCommandSchema` using `z.discriminatedUnion()`
  - Add validation for volume (0-100 range) in SET_VOLUME command

  **Extension Settings (`settings.ts`):**
  - Convert `SpeakerSelectionState` from manual interface to `SpeakerSelectionStateSchema`
  - Update `loadSpeakerSelection()` to use `safeParse()` for runtime validation

- Updated dependencies [[`6921795`](https://github.com/brew-lab/thaumic-cast/commit/6921795b559217b5ee5342852e7c59b80fc858d4), [`7629de4`](https://github.com/brew-lab/thaumic-cast/commit/7629de408fa0aad7e2a454726d890fb32df3d6ee), [`a8ee07e`](https://github.com/brew-lab/thaumic-cast/commit/a8ee07e4510f88292c9452d8ead84ac79a3d077a), [`9ee78a4`](https://github.com/brew-lab/thaumic-cast/commit/9ee78a4240e0abe22ddff3765baf18988de2f9b3), [`823bbf7`](https://github.com/brew-lab/thaumic-cast/commit/823bbf7ec9cf517ddf5e1076c195de7e05b8be2b), [`4082c40`](https://github.com/brew-lab/thaumic-cast/commit/4082c40e2b7bef74d4a46d61c7325880a2169ddd), [`f158fb2`](https://github.com/brew-lab/thaumic-cast/commit/f158fb22a398e1adcac5b344b118a10a9bdcde61), [`b2d3b7c`](https://github.com/brew-lab/thaumic-cast/commit/b2d3b7c146d183217d79c04004f775c8dbedf0c8), [`08673ee`](https://github.com/brew-lab/thaumic-cast/commit/08673eee4b0c1916f7e4abb79caa49effcffc4f7), [`2109faf`](https://github.com/brew-lab/thaumic-cast/commit/2109faf6fa40452a56789ddd08f22ccf08d884bb), [`478ab65`](https://github.com/brew-lab/thaumic-cast/commit/478ab650978fe271f8857307b835a4e1b61c5262), [`be4e2d0`](https://github.com/brew-lab/thaumic-cast/commit/be4e2d0c281f8f3ec0cb24cbe00bec55c97808d9)]:
  - @thaumic-cast/protocol@0.2.0
  - @thaumic-cast/ui@1.0.0

## 0.9.0

### Patch Changes

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`03e3c7e`](https://github.com/brew-lab/thaumic-cast/commit/03e3c7e02bc27047448f8c43e9b505eee99bad51) Thanks [@skezo](https://github.com/skezo)! - Use adaptive backoff for backpressure handling in audio consumer worker
  - Reduces CPU spinning during sustained backpressure from ~1000 wakeups/sec to ~25 wakeups/sec
  - Exponential backoff: 5ms → 10ms → 20ms → 40ms (capped) while backpressured
  - Recovers quickly when pressure eases by resetting consecutive cycle counter

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`5943fa0`](https://github.com/brew-lab/thaumic-cast/commit/5943fa0c896b0b6fce4b3c1d25f4cfa435f17a00) Thanks [@skezo](https://github.com/skezo)! - Convert CSS module classes from camelCase to kebab-case
  - Updated all CSS module class selectors to use kebab-case naming convention
  - Updated corresponding TSX imports to use bracket notation for kebab-case properties
  - Enforced by new stylelint selector-class-pattern rule

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`caa3e5d`](https://github.com/brew-lab/thaumic-cast/commit/caa3e5d02416764e11b68b4bb949f3a7ab1598e6) Thanks [@skezo](https://github.com/skezo)! - Debounce dominant color cache persistence
  - Refactored to use DebouncedStorage utility for consistency with other caches
  - Cache writes are now debounced (500ms) instead of firing on every extraction
  - Reduces chrome.storage.session.set calls during rapid image changes

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`8375f3a`](https://github.com/brew-lab/thaumic-cast/commit/8375f3a50b11df70d428d52a451141257c0b3123) Thanks [@skezo](https://github.com/skezo)! - Add manual server configuration to onboarding and new Disclosure component
  - When auto-discovery fails during onboarding, users can now manually configure the server URL
  - Added collapsible Disclosure component to shared UI package
  - Extracted testServerConnection utility for connection testing
  - Fixed WizardStep content padding to prevent focus outline clipping

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`e6c382b`](https://github.com/brew-lab/thaumic-cast/commit/e6c382b3137fc98264e3bd809314550c2c25ec5c) Thanks [@skezo](https://github.com/skezo)! - Default custom audio settings to PCM codec instead of AAC-LC

  PCM is always available as raw audio passthrough with no WebCodecs dependency, ensuring the default settings always work regardless of browser/system codec support.

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`1d38aa1`](https://github.com/brew-lab/thaumic-cast/commit/1d38aa1265c51a22787e33bf13e5f9c592277c79) Thanks [@skezo](https://github.com/skezo)! - Rate-limit healthy stats logging to reduce log noise
  - Diagnostic logs now fire immediately when issues are detected (drops, underflows)
  - When healthy, logs are rate-limited to once every 30 seconds as a heartbeat
  - Reduces log churn from 1/sec to 1/30sec during normal operation

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`2f7b86e`](https://github.com/brew-lab/thaumic-cast/commit/2f7b86e4f2c461a836adec7e91e3d8ce56c590c8) Thanks [@skezo](https://github.com/skezo)! - Use single-pass max for artwork selection
  - Replaces sort-based selection with O(n) single-pass approach
  - Avoids array allocation from Array.from()
  - Parses each size only once instead of multiple times during sort

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`070afca`](https://github.com/brew-lab/thaumic-cast/commit/070afca65cc5c323aa0cc2e57117be1e846d04ed) Thanks [@skezo](https://github.com/skezo)! - fix(ui): WCAG 2.1 AA accessibility improvements

  **SpeakerMultiSelect**
  - Replace incorrect `role="listbox"` with semantic `<fieldset>` and native checkboxes
  - Use `<label>` wrapping for proper accessible names

  **VolumeControl**
  - Add `:focus-visible` styling for slider thumbs (webkit + moz)
  - Use logical properties consistently (`block-size` instead of `height`)

  **Disclosure**
  - Add `aria-controls` and `aria-describedby` (only when elements exist in DOM)
  - Add `aria-hidden` to decorative chevron icon

  **StatusChip**
  - Add Lucide icons to convey status without relying on color alone (WCAG 1.4.1)

  **Button/IconButton**
  - Fix disabled state contrast using `opacity` + `grayscale` filter to preserve variant identity

  **ToggleSwitch**
  - Make `aria-label` a required prop for WCAG 4.1.2 compliance

  **Wizard**
  - Use `aria-labelledby` to reference step title

  **Alert**
  - Add `aria-hidden="true"` to dismiss button icon

  **Card**
  - Add `titleLevel` prop for configurable heading hierarchy

  **SpeakerVolumeRow**
  - Add `role="group"` with `aria-label` for speaker context
  - Make label props required for proper i18n support

  **Extension**
  - Add interpolated i18n keys for speaker-specific accessible labels

- Updated dependencies [[`5943fa0`](https://github.com/brew-lab/thaumic-cast/commit/5943fa0c896b0b6fce4b3c1d25f4cfa435f17a00), [`8375f3a`](https://github.com/brew-lab/thaumic-cast/commit/8375f3a50b11df70d428d52a451141257c0b3123), [`0bb42f7`](https://github.com/brew-lab/thaumic-cast/commit/0bb42f7d38b93fbb523c87978ef8de066d357b12), [`070afca`](https://github.com/brew-lab/thaumic-cast/commit/070afca65cc5c323aa0cc2e57117be1e846d04ed)]:
  - @thaumic-cast/ui@0.1.0

## 0.8.4

## 0.8.3

### Patch Changes

- [#32](https://github.com/brew-lab/thaumic-cast/pull/32) [`f633dda`](https://github.com/brew-lab/thaumic-cast/commit/f633dda4f4146a81a908c14a6b79dfc44ca6f674) Thanks [@skezo](https://github.com/skezo)! - ### Bug Fixes
  - **SpeakerMultiSelect**: Allow deselecting all speakers. Previously the last selected speaker's checkbox was disabled to prevent empty selection. Now all checkboxes behave consistently, and the Cast button disables when no speakers are selected.
  - **Speaker Selection**: Fix auto-reselection bug where clearing all speakers would immediately re-select the first one. Auto-selection now only occurs on initial load.
  - **Speaker Ordering**: Sort speaker groups alphabetically by name for consistent UI ordering. Previously order could vary depending on which speaker responded to topology queries.
  - **Speaker Selection Persistence**: Remember selected speakers across popup opens. Selection is stored in chrome.storage.local (device-specific). On load, validates saved IPs against available speakers and falls back to auto-select if speakers are no longer available.

  ### Features
  - **Multi-Speaker Volume Controls**: When multiple speakers are selected, show labeled volume controls for each speaker instead of just the first one. Each control displays the speaker name and allows independent volume/mute adjustment before casting.

- [#30](https://github.com/brew-lab/thaumic-cast/pull/30) [`ed53246`](https://github.com/brew-lab/thaumic-cast/commit/ed5324601596c527a378fe56a95b4d33aab1b83f) Thanks [@skezo](https://github.com/skezo)! - ### Refactoring & Code Quality
  - **Route System**: Replace switch-based router with typed route registry and `registerValidatedRoute` factory, eliminating 17 manual `.parse()` calls
  - **Message Types**: Reorganize message types by direction (inbound/outbound), remove deprecated types and unused exports
  - **Domain Models**: Add `Speaker` and `SpeakerGroupCollection` domain models with type-safe operations
  - **Service Layer**: Add `OffscreenBroker` for type-safe offscreen communication, `NotificationService`, and `PersistenceManager`
  - **Hook Extraction**: Extract reusable hooks (`useChromeMessage`, `useMountedRef`, `useOptimisticOverlay`, `useStorageListener`, `useSpeakerSelection`, `useExtensionSettingsListener`) to reduce boilerplate
  - **Background Split**: Split monolithic `main.ts` files into focused domain handler modules
  - **Validation**: Add Zod schema validation for runtime message type safety

  ### Bug Fixes
  - Fix auto-stop notification timer lifecycle (prevent race conditions with rapid notifications)
  - Add FIFO eviction to in-memory dominant color cache (prevent unbounded growth)
  - Preserve reconnect counter across WebSocket reconnection attempts
  - Clean up sessions properly on disconnect
  - Preserve `supportedActions` and `playbackState` in metadata validation
  - Fix message type shape mismatches

  ### Performance
  - Only poll for video elements when video sync is enabled (eliminates unnecessary `getBoundingClientRect` calls)

  ### Cleanup
  - Remove dead code: `device-config.ts`, `getModeLabel`, `BitrateSelector`, `CodecSelector`, `createDebouncedStorage`, `clearDiscoveryCache`
  - Remove unused Battery Status API permission
  - Remove redundant `SESSION_HEALTH` message
  - Add `noop` utility for explicit silent error handling

- Updated dependencies [[`f633dda`](https://github.com/brew-lab/thaumic-cast/commit/f633dda4f4146a81a908c14a6b79dfc44ca6f674)]:
  - @thaumic-cast/ui@0.0.5

## 0.8.2

### Patch Changes

- [#28](https://github.com/brew-lab/thaumic-cast/pull/28) [`21e4991`](https://github.com/brew-lab/thaumic-cast/commit/21e4991c5769c6d50b7cff677d05245fb6021afa) Thanks [@skezo](https://github.com/skezo)! - Fix SoC and DRY violations across extension and UI packages

  **Extension:**
  - Fix connection state sync after service worker wake-up
  - Unify connection state to single source of truth
  - Centralize discovery/connection logic in background
  - Centralize stop-cast cleanup in stopCastForTab
  - Move i18n translations to presentation layer
  - Use validated settings module for init functions
  - Extract codec cache to shared module

  **UI:**
  - Remove hardcoded English defaults from ActionButton labels for i18n support

- Updated dependencies [[`21e4991`](https://github.com/brew-lab/thaumic-cast/commit/21e4991c5769c6d50b7cff677d05245fb6021afa)]:
  - @thaumic-cast/ui@0.0.4

## 0.8.1

### Patch Changes

- Updated dependencies [[`7af7ee1`](https://github.com/brew-lab/thaumic-cast/commit/7af7ee150acabc9812cf74bd8d1c9edd1e8edded)]:
  - @thaumic-cast/ui@0.0.3

## 0.8.0

### Minor Changes

- [#24](https://github.com/brew-lab/thaumic-cast/pull/24) [`2a2941e`](https://github.com/brew-lab/thaumic-cast/commit/2a2941e97ddd5861b5e13ad35eee09f5dd65a95f) Thanks [@skezo](https://github.com/skezo)! - Sync tab media playback with Sonos transport state - pauses tab when any speaker pauses, resumes when all speakers are playing

## 0.7.0

### Patch Changes

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`396fc4a`](https://github.com/brew-lab/thaumic-cast/commit/396fc4ac72ab8123bf8205db2fc0d68af9354472) Thanks [@skezo](https://github.com/skezo)! - Improve video sync with SE-based stability and event handling
  - Use standard error (SE) for stability gate instead of raw stdev - converges properly under RelTime quantization
  - Add p10 estimator with adaptive floor for lock latency selection
  - Add video event listeners for re-acquire on seeked, waiting, stalled, pause, play
  - Use persisted stall check (400ms) to avoid transient re-acquires from adaptive streaming hiccups
  - Add sync jump detection logging for debugging
  - Use requestVideoFrameCallback (RVFC) for frame-accurate sync when available
  - Add playbackRate fighting detection with automatic pause mode fallback
  - Record coarse alignment anchors at pause start (not after wait) to fix double-delay bug

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`afbe950`](https://github.com/brew-lab/thaumic-cast/commit/afbe95005caa9dea84483d1fea0fe0c93e65e714) Thanks [@skezo](https://github.com/skezo)! - Add video sync opt-in feature with per-cast toggle
  - Add global video sync setting in Options (under Advanced section)
  - Add per-cast video sync toggle in ActiveCastCard popup UI
  - Add StatusChip and ToggleSwitch UI components with WCAG AA compliant colors
  - Status chip backgrounds use dominant artwork color for visual cohesion
  - Fix re-acquire loop caused by coarse alignment triggering play event
  - Disable video sync automatically when cast stops
  - Prevent log spam when video sync enabled on page without video element

- Updated dependencies [[`afbe950`](https://github.com/brew-lab/thaumic-cast/commit/afbe95005caa9dea84483d1fea0fe0c93e65e714)]:
  - @thaumic-cast/ui@0.0.2
  - @thaumic-cast/protocol@0.1.1

## 0.6.1

## 0.6.0

### Minor Changes

- [#17](https://github.com/brew-lab/thaumic-cast/pull/17) [`cf0b867`](https://github.com/brew-lab/thaumic-cast/commit/cf0b867942b54fd1f099d1bc031ebe1cc5f2b860) Thanks [@skezo](https://github.com/skezo)! - Add server-side WAV encoding for lossless audio streaming
  - Add "Lossless (WAV)" codec option that sends raw PCM from browser to desktop app
  - Desktop app wraps PCM in WAV container for true lossless quality
  - Works universally since PCM passthrough has no browser codec dependencies
  - Hide bitrate selector in UI for lossless codecs (no bitrate options)

### Patch Changes

- [#17](https://github.com/brew-lab/thaumic-cast/pull/17) [`18e2e0e`](https://github.com/brew-lab/thaumic-cast/commit/18e2e0e0431c0022f9d382f49ed1228897ea3b41) Thanks [@skezo](https://github.com/skezo)! - Improve audio settings and codec detection
  - Remove legacy AudioSettings code (dead code cleanup)
  - Fix codec detection to run via offscreen document (AudioEncoder not available in service workers)
  - Add latencyMode option to custom audio settings (quality/realtime)
  - Hide latencyMode UI for codecs that don't use WebCodecs (PCM)
  - Default to high quality (lossless) audio mode for lower CPU usage

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

### Patch Changes

- [#13](https://github.com/brew-lab/thaumic-cast/pull/13) [`4d7d238`](https://github.com/brew-lab/thaumic-cast/commit/4d7d238e381441988da6254205a23283746ad353) Thanks [@skezo](https://github.com/skezo)! - Refactor popup UI to integrate controls into media cards
  - Move speaker selection, volume controls, and cast button into CurrentTabCard
  - Add volume controls and stop button to ActiveCastCard
  - Remove separate "Cast settings" card for cleaner UI
  - Reorder layout: Active Casts now appear above Current Tab

## 0.4.0

### Minor Changes

- [#11](https://github.com/brew-lab/thaumic-cast/pull/11) [`5b6d1f2`](https://github.com/brew-lab/thaumic-cast/commit/5b6d1f2022a200c08357f7eb40c294d5aa58a9e6) Thanks [@skezo](https://github.com/skezo)! - Add settings page with audio presets and server configuration
  - Add options page with server, audio, language, and about sections
  - Create preset resolution system that integrates runtime codec detection
  - Support auto/low/mid/high/custom audio modes with fallback chains
  - Add server auto-discover with manual URL override option
  - Move audio configuration from popup to dedicated settings page
  - Use shared UI components (Card, Button) from @thaumic-cast/ui
  - Replace console.\* with shared logger throughout extension

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

## 0.2.0

### Minor Changes

- [#5](https://github.com/brew-lab/thaumic-cast/pull/5) [`1f32958`](https://github.com/brew-lab/thaumic-cast/commit/1f32958fb07f8580f36ce118d98fd9597d0244c6) Thanks [@skezo](https://github.com/skezo)! - Reduced audio encoder memory allocations — Audio encoders (AAC, Vorbis, FLAC) now use pre-allocated buffers for format conversion, reducing per-frame allocations from 2-4 down to 1. This prevents GC-induced stuttering and crackling on low-end devices.

- [#5](https://github.com/brew-lab/thaumic-cast/pull/5) [`1f32958`](https://github.com/brew-lab/thaumic-cast/commit/1f32958fb07f8580f36ce118d98fd9597d0244c6) Thanks [@skezo](https://github.com/skezo)! - Increase ring buffer from 1 second to 2 seconds, providing more headroom during CPU spikes and switch WebCodecs `latencyMode` from `realtime` to `quality` for better audio at same bitrate

## 0.1.1

### Patch Changes

- [#2](https://github.com/brew-lab/thaumic-cast/pull/2) [`e9169f5`](https://github.com/brew-lab/thaumic-cast/commit/e9169f5094b25262f7f376b82954d46160ca9f40) Thanks [@skezo](https://github.com/skezo)! - Fix runtime errors and audio streaming issues
  - Fix nested anchor tags in Sidebar causing "improper nesting of interactive content" warnings
  - Fix TypeScript types to match Rust backend ZoneGroup structure
  - Fix undefined coordinator access causing infinite re-render loop
  - Fix AudioWorkletNode not connected to audio graph, preventing audio capture
  - Fix codec mismatch in WebSocket handshake causing wrong Content-Type for Sonos
  - Fix XML escaping in SOAP/DIDL to escape all 5 XML special characters (was missing " and ')
