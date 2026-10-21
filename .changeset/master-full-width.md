---
'@thaumic-cast/ui': patch
'@thaumic-cast/extension': patch
---

fix(extension): give the open cast's master volume the full width

In an open cast of two or more rooms, the volume line for the whole cast stopped short to line up
with the rooms' sliders under it. It now runs the full width of the card again; the rooms' lines are
unchanged.
