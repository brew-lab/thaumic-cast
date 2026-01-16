---
'@thaumic-cast/extension': patch
---

Improve audio pipeline timing with performance.now()-based rate control

- Add time-based frame pacing to produce frames at ~20ms intervals instead of burst processing
- Replace frame-count based draining with time-budget based approach (~4ms per wake cycle) to avoid setTimeout timer coalescing issues
- Check backpressure per-frame instead of per-wake for finer-grained flow control
- Allow burst catch-up of ~3 frames when recovering from brief stalls, with drift clamping to prevent unbounded catch-up
