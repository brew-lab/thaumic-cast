---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

fix(core): serve PCM streams chunked so a cast to a Playbar no longer stops after 3h06m

A PCM cast to a Sonos Playbar stopped after 3h06m, exactly 2^31 bytes at 48 kHz stereo: PCM declared a
`Content-Length` of 4294967295, and the Playbar caps a declared length at 2^31. PCM is now served like every other
codec, with no `Content-Length`: chunked to an HTTP/1.1 client, and to an HTTP/1.0 client as an HTTP/1.0 response that
ends only when the connection closes. The WAV header still declares 0xFFFFFFFF in both size fields, which the Playbar
treats as unbounded when no length is declared; in field tests a chunked cast played on past the 2^31 boundary with
its reserve intact. The fixed length was first added because Sonos was thought to stutter on chunked WAV; that
stutter was the speaker's thin reserve, which the speaker head start fixed. `THAUMIC_PCM_HTTP_FRAMING=length` still
serves the old 4294967295-byte length for comparison, and `close` stays available, both experimental. The speaker
monitor's acknowledged-bytes lag counts the chunk framing, so it stays right on a chunked PCM connection.
