---
'@thaumic-cast/ui': patch
'@thaumic-cast/extension': patch
---

fix(ui): fade a cast's coloured band to the new track's colour

When the track changed, the coloured band behind an open cast in the popup jumped to the new
artwork's colour at once. The band, its edge and the words and buttons on it now fade to the new
colour together, in about a quarter of a second, and a track with no artwork fades the band out
rather than dropping it. Opening and closing a cast stays instant, and with reduced motion
switched on the colour changes at once.
