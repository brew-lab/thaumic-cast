---
'@thaumic-cast/core': patch
'@thaumic-cast/protocol': patch
'@thaumic-cast/extension': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

feat(core): key hand-set start levels by room

A start level set by hand before Cast now belongs to one room, named by its player UUID, rather than to every room the cast's speaker plays in. In a Sonos group, the room you set starts at your level and its grouped partners start no louder than the limit, so setting the Kitchen to 45 no longer sets the Patio beside it to 45 too. `START_PLAYBACK`'s `startVolume` carries `rooms` in place of `speakers`; neither was in a release.
