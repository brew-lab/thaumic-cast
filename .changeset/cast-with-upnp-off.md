---
'@thaumic-cast/core': minor
'@thaumic-cast/protocol': minor
'@thaumic-cast/extension': minor
'@thaumic-cast/desktop': minor
'@thaumic-cast/server': minor
---

feat: cast to Sonos speakers with UPnP switched off

When the Sonos app's Account > Privacy & Security > Connection Security > UPnP switch is off, Thaumic Cast now
controls the speakers over their own local connection (port 1443) instead of refusing to cast. UPnP stays the main
route, and is used again as soon as the switch is back on and nothing is playing over the other one.

Everything a cast does works the same way: PCM, AAC and MP3 casts, long PCM casts carried on past each segment with
no gap, rooms grouped and put back afterwards, start levels, volume and mute, drift correction, video sync, and the
"taken over" and "stopped" notices. FLAC cannot play over that connection, so a FLAC cast there says so and suggests
PCM or AAC.

If UPnP is switched off during a cast, the cast moves across with a short skip and the popup says it moved; a cast
that cannot move (FLAC) is stopped and says why. With the Sonos app's Authentication switched on, the speakers refuse
both routes: the existing notice to switch UPnP on is shown, and a cast that was playing can still be stopped.
