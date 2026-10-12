---
'@thaumic-cast/extension': minor
'@thaumic-cast/protocol': patch
'@thaumic-cast/ui': patch
---

feat(extension): cast chosen rooms as one Sonos group

With a desktop app or server that can regroup, a cast now plays exactly the rooms you chose, as one Sonos group,
and nothing else. A chosen room in a Sonos group with rooms you did not choose leaves that group until you stop,
and the companion puts it back afterwards. The line under the Cast button says so once: "Kitchen leaves its Sonos
group until you stop." When a chosen room leads a group that is playing, the rooms it leaves behind carry on with
their music from the top, and the line says that too: "Music in Patio starts again from the top." The line then
leaves out "Whatever the speaker is playing will stop.", which beside it would read as if Patio stopped. A cast's
volume
moves every room in its group together, and Undo after Remove puts a room back at its own level. A room that did not
start shows "did not join" on its row, with Try again. Resuming from the tab names the cast's rooms again, so a room
someone moved elsewhere is left where it is. A room of the cast is named by its room in notes and in the toolbar
badge's tooltip.

An older companion cannot regroup, so a cast to it still goes to the chosen rooms' whole Sonos groups, and the line
still says which other rooms play too. The extension learns which it is talking to from the companion's `/health`,
read again before every cast.
