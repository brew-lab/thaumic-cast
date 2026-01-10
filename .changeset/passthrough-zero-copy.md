---
'@thaumic-cast/desktop': patch
---

Eliminate unnecessary memory copy for passthrough audio streams

- Changed Transcoder trait to accept `Bytes` instead of `&[u8]`
- Passthrough now returns input directly without copying
- Removes ~100 memcpys/second for pre-encoded streams (AAC, FLAC, Vorbis)
