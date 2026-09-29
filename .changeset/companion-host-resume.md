---
'@thaumic-cast/core': patch
---

fix(core): never send a resume Play to a player on the companion's own machine

A local player such as VLC on the desktop machine reconnecting counted as a speaker resuming, so the server sent a
Sonos SOAP Play to the computer's own address and logged `[Resume] Play command on HTTP resume failed`. Its reconnect
is still a resume (the prefill wait is skipped and it keeps its own epoch), but only a speaker the stream is playing on
is now sent Play.
