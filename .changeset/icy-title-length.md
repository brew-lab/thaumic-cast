---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

fix(core): keep a very long track title from corrupting an AAC stream

The title sent to a speaker inside an AAC stream has a size limit of about 4,000 bytes. A longer title (or a shorter one
with many apostrophes, each of which takes three bytes once sent) overflowed the size marker, so the speaker read the
title text as audio. A title over the limit is now shortened to fit, without splitting a character.
