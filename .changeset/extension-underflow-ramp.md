---
'@thaumic-cast/extension': minor
---

Add extension-side ramp when underflow happens before sending PCM

**Underflow Ramp-Down**

- Detect underflow via `Atomics.waitAsync` timeout (200ms)
- Capture last samples from partial frame buffer for continuity
- Apply 3ms linear fade-out from last amplitude to silence
- Fill remainder of frame with zeros before encoding

**Resume Ramp-In**

- Track `needsRampIn` flag when underflow occurs
- Apply 3ms linear fade-in on first frame after resume
- Only clear flag if ramp was actually applied (guards edge cases)

**Implementation**

- Shared `applyRamp()` utility for both fade-in and fade-out (DRY)
- Reusable `lastSamples` buffer to avoid allocation on underflow
- Frame-based ramp math ensures all channels get identical gain
- Proper interpolation: fade-in starts at 0, fade-out starts at 1
