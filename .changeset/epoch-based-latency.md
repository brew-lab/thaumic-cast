---
'@thaumic-cast/desktop': patch
---

Add epoch-based latency measurement for video sync

- Per-speaker playback epochs anchored to oldest prefill frame served
- Emit `epochId` and `jitterMs` in latency events for extension state machine
- Add `LatencyEvent::Stale` when no valid position data for 30s
- TTL cleanup for epoch HashMap (max 20 entries per stream)
