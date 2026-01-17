---
'@thaumic-cast/desktop': minor
'@thaumic-cast/extension': patch
'@thaumic-cast/protocol': patch
---

Improve WAV streaming reliability for Sonos speakers

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
