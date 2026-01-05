---
'@thaumic-cast/desktop': minor
'@thaumic-cast/extension': minor
---

Add server-side WAV encoding for lossless audio streaming

- Add "Lossless (WAV)" codec option that sends raw PCM from browser to desktop app
- Desktop app wraps PCM in WAV container for true lossless quality
- Works universally since PCM passthrough has no browser codec dependencies
- Hide bitrate selector in UI for lossless codecs (no bitrate options)
