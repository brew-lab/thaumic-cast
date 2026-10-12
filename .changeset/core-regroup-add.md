---
'@thaumic-cast/core': minor
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

feat(core): join rooms added to a running cast to its group

A room added to a cast that is already playing now joins the cast's Sonos group, so it plays in step with the rest,
instead of playing its own copy of the stream. It is set to its start level first. If it led a Sonos group of other
rooms, it hands that group on (their music starts again from the top) and goes back to it when it is removed from the
cast or the cast stops. Asking a cast to play its own rooms again, as a resume does, changes no volume and moves
nothing; a room someone has since moved to another group in the Sonos app is left there, and the cast stops counting
it.
