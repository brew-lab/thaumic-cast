---
'@thaumic-cast/protocol': patch
'@thaumic-cast/core': patch
---

feat(protocol): describe rooms

A new `roomsOf()` folds the speaker groups into rooms, as the Sonos app lists them: a home theatre or a stereo pair is one room, named by its primary's player UUID, and each room says which Sonos group it is in, who coordinates it and which rooms it is grouped with. With an older companion that does not mark bonded speakers, speakers of one group that share a room name are folded instead. `roomLevel()` reads a room's level before Cast (known for a room alone in its group, not yet known for one inside a bigger group), and `roomAvailability()` says whether it is free. The companion folds the same way, and a shared fixture holds the two to it.
