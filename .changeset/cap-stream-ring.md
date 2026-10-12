---
'@thaumic-cast/core': patch
'@thaumic-cast/server': patch
'@thaumic-cast/desktop': patch
---

fix(core): cap how much a stream's ring buffer can reserve

A stream's ring buffer is reserved in full when the stream starts. Its size was already bounded in practice (the frame length a client asks for is clamped to 5–150 ms), but nothing capped it at the point of allocation. It is now capped at the ring the shortest allowed frame needs (600 frames), and the server refuses a configured ring larger than that.
