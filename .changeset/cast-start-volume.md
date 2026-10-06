---
'@thaumic-cast/extension': patch
'@thaumic-cast/protocol': minor
'@thaumic-cast/core': patch
'@thaumic-cast/ui': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

feat(core): start every cast at a safe volume

A cast used to start at whatever level the room was left at, so after a party it could start at 80 or more. Now a cast starts no louder than 30. A room that is louder is turned down to 30 just before the cast plays; a quieter room is left where it is, so Thaumic Cast never turns a room up to start. In a Sonos group each room is set on its own, so a quiet room stays quiet. If a room's level cannot be read, it starts at 30. The limit is in Settings, under "Start no louder than", where it can be changed or turned off.

Before you cast, the volume slider for each speaker no longer changes the speaker straight away, so you can no longer turn up someone else's music by accident. It now sets the level the cast will start at, and shows the room's level now beside it, for example "Now 72; starts at 30". A level you set here is used for this cast only, and can be above the limit.

A speaker shows "…" until it has reported its level, instead of a made-up 50. A speaker with a fixed line-level output, such as a Port, shows "Fixed" instead of a slider, and its volume is never changed.

The start level is set by the desktop app or server, so both behave the same. An older desktop app or server ignores it and starts casts at the room's level, as before.
