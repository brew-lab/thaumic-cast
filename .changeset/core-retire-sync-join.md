---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

refactor(core): retire the old speaker-sync join, keeping older extensions working

An older extension with "Play speakers as one group" on still gets one Sonos group, but it is now formed the new
way: every room of the speakers it names plays together, no speaker that leads other rooms is told to join another
group while those rooms still follow it, and the rooms go back into their groups when the cast stops. The extension
hears only about the speakers it named, so it shows no extra rows, and removing one of them takes the rest of its
group along, as before. With the setting off, each speaker still plays its own copy of the stream, as before.
