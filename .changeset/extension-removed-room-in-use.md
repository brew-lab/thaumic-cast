---
'@thaumic-cast/extension': patch
---

fix(extension): stop a room removed from a cast reading as in use

A room that stopped as it left a cast, removed or taken by another cast, could keep showing "In use" with nothing
playing on it. Its stop arrived a moment before the companion said it had left the cast, and the extension threw the
stop away with the room, so the room still read as playing. The stop is now kept.
