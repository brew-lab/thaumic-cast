---
'@thaumic-cast/desktop': patch
---

Fix WAV/PCM passthrough pause/resume requiring double play press from Sonos app by rejecting Range requests with 416 and signaling Accept-Ranges: none
