---
'@thaumic-cast/core': minor
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

feat(core): cast to rooms as one Sonos group

A cast can now name the rooms it plays, and the desktop app or server plays exactly those rooms as one Sonos group.
Rooms you did not pick keep playing whatever they were playing. If the rooms you picked are already one Sonos group,
nothing is regrouped. Otherwise the cast is led by a group made only of rooms you picked, if there is one, and each
other room leaves its Sonos group, is set to its start level, and then joins the cast. A room that led a group of
rooms you did not pick hands that group on first, and the music there starts again from the top. A home theatre or
stereo pair counts as one room, and its satellites are never sent anything. If the room leading the cast cannot
play, no other room is touched; if one room cannot join, the others still play and that room is reported on its own.
Only one regroup runs at a time, and each one reads the grouping fresh from a speaker before it starts, asking the
chosen rooms first; if no speaker answers, the cast moves nothing and every room is reported, rather than planning
from a grouping that may be out of date. Rooms added to a cast whose leading room someone else has regrouped are
refused rather than given a second leader.

A cast that takes a room from another running cast leaves that cast playing in the rooms it keeps. When the room
taken leads the other cast, the other cast is handed on to one of its remaining rooms first, as Remove does, rather
than stopped with it or left for Sonos to hand on unseen, which ended it. A room taken that only follows the other
cast leaves its group and is never sent a Stop, which belongs to its whole group.

A cast to a single room now reads and follows that room's own level as a cast to several rooms does. A room that
left its Sonos group to play alone has no level of its own on record, and a room standing alone could have lost its
first report, so such a room showed "…" in place of its level for as long as it played.
A room's level is asked for once more if the first read as it joins fails. A room switched to other music leaves the
cast's level following even when no room follows it, so a later cast reads its level afresh.
