---
'@thaumic-cast/desktop': patch
'@thaumic-cast/ui': patch
---

fix(desktop): keep the onboarding's buttons at the bottom of the window

The onboarding's footer (Skip, Back and Carry on) sat straight under each step, so it moved up
and down from one step to the next and left empty space below it. It now sits at the bottom of
the window on every step and at every window size, with the step top-aligned above it. A step
taller than the window scrolls above the footer, which stays in the same place.
