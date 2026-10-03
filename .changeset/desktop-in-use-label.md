---
'@thaumic-cast/desktop': patch
---

fix(desktop): say a speaker is in use when something else is playing on it

A speaker card read "Playing" whenever the speaker played anything, so a speaker playing from another app looked the same as one playing a cast of ours. It now reads "In use", in an amber badge, when something else is playing on it. "Loading", "Paused" and "Not playing" are unchanged, and a speaker with one of our casts still reads "Casting".
