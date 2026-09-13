---
'@thaumic-cast/core': patch
---

fix(core): resynchronise a client that falls behind

Only successful reads from the event channel were handled, so a client that stalled lost events silently and its view
of speakers, volumes and sessions drifted until it reconnected. A closed channel did not end the connection either.
Falling behind now logs and re-sends the state snapshot, and a closed channel ends the loop.
