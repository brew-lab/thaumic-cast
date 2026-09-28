---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

feat(core): keep an eye on every speaker that fetches a stream, with a setting to turn it off

Speakers were only asked for their playback position when a client wanted video sync, so a speaker slowly running out
of audio during an ordinary cast left nothing in the log until it could be heard. Monitoring now follows the stream
itself: whichever speaker actually fetches the audio is polled with a quiet GetPositionInfo every two to three
seconds, however the cast was started, and never more than 120 times a minute across the whole server. Grouped
speakers and home-theatre satellites, which never fetch, are never polled. A speaker that reports another track is
left alone until it fetches the stream again, a poll taken while it is known to be paused is not counted, and GENA's
transport state is only believed once it has been heard since the speaker was first watched, with GetTransportInfo
every 30 seconds standing in when it has not. Monitoring is on by default. It can be switched off in the desktop
Settings view, with `speaker_monitor: false` in the server's config.yaml, or with `THAUMIC_SPEAKER_MONITOR=off`, which
restores the old behaviour of polling only video-sync casts; video sync works either way, and a change applies from
each speaker's next connection.
