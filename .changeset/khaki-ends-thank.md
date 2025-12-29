---
'@thaumic-cast/extension': minor
---

Reduced audio encoder memory allocations — Audio encoders (AAC, Vorbis, FLAC) now use pre-allocated buffers for format conversion, reducing per-frame allocations from 2-4 down to 1. This prevents GC-induced stuttering and crackling on low-end devices.
