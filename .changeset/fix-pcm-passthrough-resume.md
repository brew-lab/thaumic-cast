---
'@thaumic-cast/desktop': patch
---

Fix WAV/PCM passthrough pause/resume by ignoring Range requests and returning fresh audio stream (200 OK) instead of failing
