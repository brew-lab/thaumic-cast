---
'@thaumic-cast/extension': patch
'@thaumic-cast/protocol': patch
---

feat(extension): cast to rooms

The popup now asks for a cast by room, and the background works out which speakers to send it to from its own view of the Sonos groups. Until rooms can be taken out of a Sonos group for a cast, a room casts to its whole group, as a group did before, so a room grouped with it plays too; the popup will say so in one line ("Patio plays too, as it is grouped with Kitchen."). Each cast remembers the rooms it was started for, and once a cast starts its rooms become your Last cast.
