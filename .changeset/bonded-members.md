---
'@thaumic-cast/core': patch
'@thaumic-cast/protocol': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

feat(core): say which members of a Sonos group are bonded

A home theatre's sub and surrounds, and the second speaker of a stereo pair, now arrive marked `invisible` in the speaker groups the companion sends, so the extension can show each room once, as the Sonos app does. The flag is sent only when set; an extension that does not know it ignores it, and a newer extension talking to an older companion folds such speakers by room name instead.
