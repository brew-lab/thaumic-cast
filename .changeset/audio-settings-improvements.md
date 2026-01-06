---
'@thaumic-cast/extension': patch
---

Improve audio settings and codec detection

- Remove legacy AudioSettings code (dead code cleanup)
- Fix codec detection to run via offscreen document (AudioEncoder not available in service workers)
- Add latencyMode option to custom audio settings (quality/realtime)
- Hide latencyMode UI for codecs that don't use WebCodecs (PCM)
- Default to high quality (lossless) audio mode for lower CPU usage
