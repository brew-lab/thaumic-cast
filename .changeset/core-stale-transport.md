---
'@thaumic-cast/core': patch
---

fix(core): read a room's transport when it leads its own group again

A room that follows another room is not asked for its transport, so the state kept for it is the last one it gave,
and a room in a cast gives "playing". When it leads its own group again, after Remove or Stop, the first report
that should replace that state could be lost, and the room then read as playing, so as in use, until something
changed on it. The companion now asks such a room for its state once it listens to it again, and tells the
extension if it differs.

A room left playing another room's music, when the room it followed joined a cast, is read the
same way, so it shows as in use even when its first report is lost.
