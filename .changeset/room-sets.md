---
'@thaumic-cast/extension': patch
---

feat(extension): keep sets of rooms on this device

The rooms you last cast to ("Last cast") and the sets of rooms you save are kept by room, in this browser only, so they are never synced to another computer that may be on another network. Each room is kept with its name, so a set can still say which of its rooms is not answering. The speakers you had chosen before become your Last cast the first time the rooms load. When the popup opens, your Last cast is chosen, or else the first room nobody else is casting to; a choice is remembered only once you cast.
