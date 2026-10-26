---
'@thaumic-cast/extension': patch
'@thaumic-cast/desktop': patch
---

Artwork with transparent areas no longer shows the default music glyph through it. The glyph holds the space while the
image loads, then fades out as the image fades in; if the image fails, it stays.
