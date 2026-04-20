---
'@thaumic-cast/core': minor
---

Add jitter buffer state machine to the cadence streaming pipeline

The `jitterBufferMs` setting now drives an active fill-gate + refill-on-underrun state machine inside the cadence stream, replacing the passive "queue size cap + upfront `tokio::time::sleep`" behavior. Sonos now receives silence cadence frames immediately while the buffer accumulates, so the first-byte timeout that required a pre-subscribe sleep on the old path is avoided.

Three states on the cadence loop (`BufferState::{Playing, Silence, Rebuffering}`):

- Startup with `target_depth > 0` enters `Rebuffering` and emits silence until the queue reaches `target_depth` (or the rebuffer timeout elapses).
- Underruns transition `Playing → Silence → Rebuffering` and refill to `target_depth` before resuming, producing one clean silence gap instead of chattering in and out of playback.
- `target_depth == 0` (pass-through mode) keeps the legacy immediate-resume behavior for users who want the lowest-latency path.

`CadenceConfig::new(silence, jitter_buffer_ms, frame_ms, format, prefill)` computes `target_depth` from the buffer setting and derives `overflow_cap = target_depth × JITTER_OVERFLOW_MULTIPLIER` (clamped), plus trims prefill to `target_depth` so the initial queue never exceeds the fill-gate target.

Policy defaults unchanged (quality = 500ms, realtime = 200ms); tuning for the MSTP + WASAPI paths is a follow-up once benchmark data is in.
