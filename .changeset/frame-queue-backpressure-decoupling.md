---
'@thaumic-cast/extension': minor
'@thaumic-cast/protocol': patch
---

Add frame queue for quality mode backpressure decoupling

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
