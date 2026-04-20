---
'@thaumic-cast/core': patch
---

Tighten the PCM jitter-buffer pipeline and add cadence startup diagnostics.

- Prefill frames returned by `subscribe()` are trimmed to the intended buffer depth (`jitter_buffer_ms / frame_duration_ms`) before being queued, keeping the newest frames. Previously a resume with a populated ring buffer could replay up to a full second of stale audio before catching up to live.
- The cadence queue's drop threshold is now `buffer_depth × JITTER_OVERFLOW_MULTIPLIER` (3) instead of a single `queue_size` value, so short producer bursts (e.g. Chrome scheduling gaps dumping backed-up frames) don't drop frames immediately. Steady-state queue depth is unchanged.
- Introduces `CadenceConfig::new(silence, jitter_buffer_ms, frame_ms, format, prefill)` as the canonical construction path; it computes `overflow_cap` and trims prefill in one place instead of duplicating the math in `api/stream.rs`.
- Adds two startup diagnostic logs — `[Cadence] Startup: prefill_frames=…` and `[Cadence] First yield: {audio|silence}` — so field logs can show whether fresh casts begin with audio or silence, independent of downstream behavior.

Startup buffering and underrun recovery behavior match pre-PR: the pre-subscribe sleep honors the user-configured `jitter_buffer_ms` (skipped on resume), and the cadence loop emits silence on underrun and resumes as soon as a frame is available.
