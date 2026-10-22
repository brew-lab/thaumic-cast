---
'@thaumic-cast/ui': patch
'@thaumic-cast/extension': patch
---

fix(extension): keep Stop beside the title when the artwork is red

When a cast's artwork was red, opening its tile moved Stop off the coloured band onto a line of
its own, so it no longer sat where it does on every other cast. Stop now stays beside the title on
every band; on a red one it takes the band's own button colour so it still stands out.
