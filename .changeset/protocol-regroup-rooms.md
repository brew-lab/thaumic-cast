---
'@thaumic-cast/protocol': minor
---

feat(protocol): carry rooms and a call id on START_PLAYBACK

`START_PLAYBACK` can now name the rooms to play, as player UUIDs in the order chosen (`rooms`), and a `callId` that the
reply echoes. `PLAYBACK_RESULTS` and `PLAYBACK_ERROR` carry that `callId` back, so a late reply to an earlier request
can no longer be taken for the reply to a retry. The companion's `/health` says `regroup: true` when it plays `rooms`
as one Sonos group and puts moved rooms back afterwards. Every field is optional: an older companion ignores `rooms`
and `callId` and plays `speakerIps` as before, and an older extension that sends neither is served as before.
`syncSpeakers` is read only when `rooms` is absent. Shared fixtures hold the extension and the companion to the new
request, the legacy request and the reply.
