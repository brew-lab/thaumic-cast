---
'@thaumic-cast/core': minor
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

feat(core): put rooms back into their Sonos groups when a cast stops

When a cast stops, or a room is removed from it, each room that left a Sonos group for the cast goes back into that
group, under whoever leads it now: if the group's old leader left for the cast, the room joins the speaker Sonos
promoted in its place. A room is only put back if nothing else has regrouped it since: a room someone moved in the
Sonos app, or took for other music, is left where it is. Rooms that were already grouped with the room leading the
cast stay grouped. Two groups merged for a cast come back as two groups. A room is put back without a Play command,
so it picks up whatever its group is playing, and a group the household paused stays paused. A room that left its
group but then could not join the cast is put back at once. When the cast's leading room is removed, another room
takes the cast over and the removed room goes back to its own group. A room that cannot leave the cast stays where
it is, and the room it still follows is not put back, so no room is ever told to join while another follows it. When
the room leading the cast switches to other music, the rooms following it play that music with it, so the cast lets
them go too and Stop leaves them alone. A room the companion is itself stopping, handing on or putting back is never
taken for one switched to other music, so removing the leading room cannot end the cast, and a Stop reports its rooms
as stopped, not taken. A Stop that comes while a cast is still joining rooms waits for it, so every room it joined goes
back. At shutdown, and on Stop all casts, stopping and putting rooms back gets a few seconds in all, across every
cast, counted once any cast still joining rooms has finished. This replaces a restore that never ran for casts started
from the popup.
