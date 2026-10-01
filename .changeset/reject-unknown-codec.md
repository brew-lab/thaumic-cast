---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
'@thaumic-cast/extension': patch
'@thaumic-cast/protocol': patch
---

fix: refuse a codec the companion cannot stream, and say so

If the extension asked for a codec the companion has no stream for, the companion quietly treated the audio as PCM, so
the speaker was handed something it could not play. The companion now refuses the cast and names the codec. Its refusals
also reach the extension: they were sent in a shape the extension discarded, so a refused cast only ever showed a
connection close code. The reason the companion gives is now what the failed cast reports, including from a companion
that has not been updated yet.

Ogg Vorbis is no longer offered, because the companion never had a stream for it. A custom quality setting saved with
Ogg Vorbis becomes AAC-LC, keeping its bitrate where AAC-LC has the same one.

Starting playback of a stream that has already gone now fails with "Stream not found" for each speaker, where it used
to send the speakers an AAC address on a guess.
