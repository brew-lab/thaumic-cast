# @thaumic-cast/protocol

## 0.2.0

### Minor Changes

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

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`7629de4`](https://github.com/brew-lab/thaumic-cast/commit/7629de408fa0aad7e2a454726d890fb32df3d6ee) Thanks [@skezo](https://github.com/skezo)! - Add TPDF dithering to audio quantization

  Apply Triangular Probability Density Function (TPDF) dithering when quantizing Float32 samples to integer formats. This decorrelates quantization error from the signal, converting audible harmonic distortion into inaudible white noise floor.

  **Changes**
  - Add `tpdfDither()` utility function to protocol package
  - Apply dithering in PCM encoder (Float32 → Int16)
  - Apply dithering in FLAC encoder 24-bit path (Float32 → Int24)

  Improves audio quality especially in quiet passages, fade-outs, and music with wide dynamic range.

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`823bbf7`](https://github.com/brew-lab/thaumic-cast/commit/823bbf7ec9cf517ddf5e1076c195de7e05b8be2b) Thanks [@skezo](https://github.com/skezo)! - Add configurable frame duration setting for PCM streaming
  - Add `frameDurationMs` field to encoder config (10ms, 20ms, or 40ms)
  - Expose Frame Duration dropdown in extension Audio settings (PCM only)
  - Display frame duration in "What You're Getting" resolved settings
  - Default remains 10ms for low latency; larger values improve stability on slow networks
  - Field named generically for future extension to other codecs

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

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`08673ee`](https://github.com/brew-lab/thaumic-cast/commit/08673eee4b0c1916f7e4abb79caa49effcffc4f7) Thanks [@skezo](https://github.com/skezo)! - Reorganize protocol package into logical modules

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

## 0.1.1

### Patch Changes

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`afbe950`](https://github.com/brew-lab/thaumic-cast/commit/afbe95005caa9dea84483d1fea0fe0c93e65e714) Thanks [@skezo](https://github.com/skezo)! - Add video sync opt-in feature with per-cast toggle
  - Add global video sync setting in Options (under Advanced section)
  - Add per-cast video sync toggle in ActiveCastCard popup UI
  - Add StatusChip and ToggleSwitch UI components with WCAG AA compliant colors
  - Status chip backgrounds use dominant artwork color for visual cohesion
  - Fix re-acquire loop caused by coarse alignment triggering play event
  - Disable video sync automatically when cast stops
  - Prevent log spam when video sync enabled on page without video element

## 0.1.0

### Minor Changes

- [#17](https://github.com/brew-lab/thaumic-cast/pull/17) [`06ffe4f`](https://github.com/brew-lab/thaumic-cast/commit/06ffe4f80c6837314941d1e47115143f3bd44d2d) Thanks [@skezo](https://github.com/skezo)! - Add latency monitoring service for measuring audio playback delay
  - Add GetPositionInfo SOAP call to query Sonos playback position
  - Track stream timing via sample count for precise source position
  - Create LatencyMonitor service with high-frequency polling (100ms)
  - Calculate latency with RTT compensation and EMA smoothing
  - Emit LatencyEvent broadcasts with confidence scoring
  - Foundation for future video-to-audio sync feature
