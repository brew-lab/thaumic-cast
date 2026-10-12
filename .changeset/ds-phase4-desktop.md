---
'@thaumic-cast/ui': minor
'@thaumic-cast/desktop': minor
'@thaumic-cast/core': patch
---

feat(desktop): rebuild the window and confirm Stop all casts

The Speakers page shows one card per room, with the rooms that are casting first. A grouped room
says which rooms it is grouped with, and says Casting, not "In use", when the Sonos app groups it
with a room that is casting. A speaker's name is never squeezed beside its status. "Stop all casts"
only shows while something is casting, and now asks first. Afterwards a message says how many casts
stopped, and how many of them were started on another computer. On the Server page the three action
buttons are one width, Stop is greyed out while nothing casts, and "Disconnect" asks first too. In
the tray, "Stop all casts" is greyed out while nothing casts.

Settings gains "Show diagnostics", which puts each casting speaker's reserve on its card (it needs
speaker monitoring). Setup counts rooms rather than speakers, and lists each room with its group.
Its Carry on button stays in view on a step taller than the window. A page that does not exist now
says so with a way back to Speakers. The window opens a little taller.
