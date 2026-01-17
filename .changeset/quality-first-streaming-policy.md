---
'@thaumic-cast/extension': minor
'@thaumic-cast/protocol': minor
---

Add quality-first streaming policy for audio

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
