---
'@thaumic-cast/desktop': minor
---

Add crossfade on silence transitions to eliminate audio pops

**Crossfade on Silence Transitions**

- Apply 2ms linear fade-out when entering silence (audio → silence)
- Apply 2ms linear fade-in when exiting silence (silence → audio)
- Track last sample pair for fade-out generation
- Cap fade samples to available frame size for short frame durations

**Channel Validation**

- Reject channel counts other than 1 (mono) or 2 (stereo) in handshake
- Crossfade utilities require mono/stereo; multi-channel is not supported

**AudioFormat Helpers**

- Add `bytes_per_sample()` and `frame_samples()` methods
- Add `is_crossfade_compatible()` check for 16-bit PCM validation
