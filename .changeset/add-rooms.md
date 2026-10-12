---
'@thaumic-cast/extension': patch
---

feat(extension): add rooms to a running cast

A room can now be added to a cast that is already playing. The added room starts at its start level and plays the cast's stream on its own, as a cast to several rooms does with "Play speakers as one group" off; joining it to the cast's Sonos group waits for the regrouping work. A room grouped in Sonos with a room already in the cast is added at once. Each room says whether it joined, so the popup can show "Joining…" and then say which rooms did not.
