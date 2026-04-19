---
'@thaumic-cast/extension': minor
---

Add MSTP audio pipeline for PCM streaming to eliminate crackling artifacts

The previous PCM path routed captured audio through `AudioContext` + `AudioWorklet` + `SharedArrayBuffer`, which crosses a clock domain between the MediaStream and AudioContext clocks. When the two clocks drifted, the worklet would emit zero-filled audio blocks, producing audible crackling.

This replaces the PCM path with a `MediaStreamTrackProcessor` (MSTP) pipeline that reads `AudioData` at the MediaStream's native rate — no clock crossing, no zero-fills. Compressed codecs continue to use the existing AudioContext path because their encoders run in the worklet.

**New:**

- `audio-relay.worker.ts`: purpose-built worker that consumes the transferred `ReadableStream<AudioData>`, extracts f32-planar channels, interleaves with TPDF dither, quantizes to Int16, and sends fixed-size frames over WebSocket.
- `keepTabAudible` in MSTP mode uses a low-volume `<audio>` element instead of an AudioContext gain node to avoid reintroducing the clock crossing.

**Supporting refactors:**

- Extracted `worker-base.ts` from `audio-consumer.worker.ts` — shared WebSocket lifecycle, frame queue, backpressure handling, stats/metrics timeline, and common message handling are now reusable across consumer worker implementations.
- Added `MetricSnapshot` + `WorkerMetricsDumpMessage` for post-session analysis.
- Tightened encoder interface and worker frame-queue types to `Uint8Array<ArrayBuffer>` so encoded audio flows to `WebSocket.send()` without casts (required by TypeScript 5.7+).
- Audio relay accumulator now owns its backing `ArrayBuffer` explicitly, matching the PCM encoder pattern and eliminating the last inline cast in the hot path.
