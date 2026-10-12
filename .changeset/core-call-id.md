---
'@thaumic-cast/core': minor
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

feat(core): echo the playback call id and say the companion regroups

The desktop app and server now copy a `START_PLAYBACK` request's `callId` onto the `PLAYBACK_RESULTS` or
`PLAYBACK_ERROR` that answers it, so the extension can ignore a late reply to an earlier request instead of taking it
for the answer to a retry. `/health` now says `regroup: true`, which tells the extension that this companion plays the
rooms it names as one Sonos group and puts moved rooms back afterwards. An older extension ignores both.
