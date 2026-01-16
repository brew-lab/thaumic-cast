---
'@thaumic-cast/extension': patch
---

Pre-allocate PCM processor conversion buffer to eliminate real-time audio thread allocations

- Move conversionBuffer allocation from process() to constructor
- Size buffer for maximum case (128 samples × 2 channels = 256 floats)
- Eliminates potential GC-induced audio glitches on low-end devices
