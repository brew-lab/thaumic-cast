---
'@thaumic-cast/core': patch
---

fix(core): say why a 24-bit request falls back to 16-bit

When a client asks for 24-bit audio in a codec other than FLAC, the stream is made 16-bit and a warning is logged.
The warning read `24-bit audio requested but codec is Pcm, falling back to 16-bit`, which suggested the codec was the
wrong one for the request rather than saying what the limit is. It now reads
`[WS] 24-bit audio requested with codec Pcm, but only FLAC carries 24-bit; streaming 16-bit`. Anyone grepping for the
old text should look for `only FLAC carries 24-bit`. What is streamed does not change.
