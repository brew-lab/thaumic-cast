---
'@thaumic-cast/extension': minor
'@thaumic-cast/protocol': minor
'@thaumic-cast/desktop': minor
---

Preserve Float32 audio throughout pipeline to enable 24-bit FLAC encoding

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
