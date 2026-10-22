---
'@thaumic-cast/ui': patch
'@thaumic-cast/extension': patch
'@thaumic-cast/desktop': patch
---

fix(ui): make the settings readouts easier to read

The list of settings under "For the next tab cast", and About in the extension and the desktop
app, read as a cramped block of bold values that started wherever the longest name ended. Each
setting now sits on its own ruled row, its name at the start and its value at the end, where the
controls above it end. A value moves under its name only when the two do not fit side by side.
The list also gives the format first and the timing after, with Falling behind last.
