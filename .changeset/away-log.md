---
'@thaumic-cast/extension': patch
---

feat(extension): log what happened while the popup was shut

The extension now remembers what happened to your casts while the popup was shut: a cast that ended on its own, a room that left a cast, the connection to the companion lost and found again while casts were running, and a room that would not stop or did not join after you closed the popup. It keeps the last 10, none older than a day, and forgets them when the browser quits. The popup holds a connection to the background while it is open, so anything it showed you live is never repeated. The popup will show them in one "While you were away" line.
