---
'@thaumic-cast/desktop': patch
---

fix(desktop): say "Paused" on a paused speaker's card

A paused speaker's card in the Speakers view showed the raw state name "PAUSED_PLAYBACK" instead of "Paused". It now says "Paused", and a test checks that every state a speaker can report has a label.
