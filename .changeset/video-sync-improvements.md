---
'@thaumic-cast/extension': patch
---

Improve video sync with SE-based stability and event handling

- Use standard error (SE) for stability gate instead of raw stdev - converges properly under RelTime quantization
- Add p10 estimator with adaptive floor for lock latency selection
- Add video event listeners for re-acquire on seeked, waiting, stalled, pause, play
- Use persisted stall check (400ms) to avoid transient re-acquires from adaptive streaming hiccups
- Add sync jump detection logging for debugging
- Use requestVideoFrameCallback (RVFC) for frame-accurate sync when available
- Add playbackRate fighting detection with automatic pause mode fallback
- Record coarse alignment anchors at pause start (not after wait) to fix double-delay bug
