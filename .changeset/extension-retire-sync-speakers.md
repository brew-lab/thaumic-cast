---
'@thaumic-cast/extension': patch
---

refactor(extension): retire "Play speakers as one group"

The setting is gone from Settings. A cast to several rooms is always one Sonos group with a companion that can
regroup, so there is nothing to choose; with an older companion each room plays the stream on its own. A stored
choice is ignored and dropped the next time settings are saved.
