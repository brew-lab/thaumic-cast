---
'@thaumic-cast/extension': minor
'@thaumic-cast/protocol': minor
---

Use codec-aware frame sizes for optimal encoder efficiency

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
