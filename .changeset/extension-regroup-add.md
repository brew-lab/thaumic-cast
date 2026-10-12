---
'@thaumic-cast/extension': patch
---

feat(extension): join added rooms to the cast's group

A room added to a cast played as one Sonos group now joins that group, with a companion that can regroup: it
leaves any Sonos group it was in, starts at its start level, and plays with the rest of the cast. It shows
"Joining…" until it answers, and "did not join" with Try again if it did not. Removing it puts it back where it was,
and Undo adds it again. While rooms are being added, the line under Add says which rooms leave their Sonos groups and
whose music starts again from the top, as the Cast line does. With an older companion an added room still plays on
its own, as before.
