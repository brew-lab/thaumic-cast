---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
'@thaumic-cast/extension': patch
'@thaumic-cast/protocol': patch
---

fix(core): stop reporting a compressed cast's speaker as still locking

A speaker's buffer can only be measured on a PCM stream. For AAC and FLAC the companion nevertheless reported the speaker
as "locking" (still measuring) for the whole cast, as if a reading were on its way. It now reports "unmeasured" for those
streams, in its log and to the extension and desktop app, and still says when such a speaker is paused, not answering or
playing something else. PCM casts are reported exactly as before.
