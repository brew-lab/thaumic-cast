---
'@thaumic-cast/ui': patch
'@thaumic-cast/extension': patch
---

fix(extension): give a one-room cast's volume the full width

In an open cast to one room, the room's volume slider stopped short of the card's end, leaving an
empty space where a Remove button would go to line up with other rooms. With one room there is
nothing to line up with, so its slider now runs the full width; casts of two or more rooms are
unchanged.
