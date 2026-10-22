---
'@thaumic-cast/desktop': patch
---

feat(desktop): use the new mark for the app and tray icons

The app icon is now the new mark, the broadcast arcs round an octagon, in purple on a clear background, as
large as the icons of the apps beside it. All four arcs show at every size, and the smallest sizes are drawn to
the pixel so they stay sharp. On macOS the mark sits on a deep purple rounded square shaped like other Mac
apps' icons, so macOS does not put it on a grey tile. The tray icon draws the octagon as an outline while idle
and fills it while something casts; its sizes, colours and light and dark variants are as before.
