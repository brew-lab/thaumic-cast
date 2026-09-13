---
'@thaumic-cast/extension': patch
---

fix(extension): keep valid settings when one stored value fails validation

Settings were validated as a whole, so a single value left over from an older build made the loader return defaults
and the next save persist them, discarding the server address, theme and audio mode. Each field is now validated on
its own and only invalid ones fall back, with the discarded names logged.
