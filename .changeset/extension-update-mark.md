---
'@thaumic-cast/extension': patch
'@thaumic-cast/ui': minor
---

feat(extension): show an update as a mark on Settings

When a newer desktop app or server is out, the popup no longer adds a row under the Cast button, which on a long
popup sat below the fold. Instead the Settings button at the top carries a small dot and is named "Settings, update
available", with that name shown when you point at it or focus it. Pressing it opens Settings at About, where the
update's link is. Nothing in the popup moves when the mark appears. The popup's frame has no end row any more.
