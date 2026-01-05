---
'@thaumic-cast/desktop': minor
'@thaumic-cast/extension': minor
---

Add server-side FLAC encoding for lossless audio streaming

- Add "Lossless (FLAC)" codec option that sends raw PCM from browser to desktop app
- Desktop app encodes PCM to FLAC using flacenc-rs for true lossless quality
- Works universally since PCM passthrough has no browser codec dependencies
- Hide bitrate selector in UI for lossless codecs (no bitrate options)
