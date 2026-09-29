---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

refactor(core): match stream URIs by stream id so segment URLs stay one session

A WAV header can declare at most 4 GiB, so the continuation work serves a long PCM cast as consecutive segments,
each under its own URL: segment 0 is the `/stream/{id}/live.wav` every PCM cast has always used, and segment `n` is
the new `/stream/{id}/live/{n}.wav`. The server now answers that route (through the same per-stream access check;
anything but a canonical `{n}.wav` on a PCM stream is a 404), and names the segment in the new-connection line.
Until segments are carried across connections, a segment is served from the live edge like `live.wav`.

A speaker moving on to a later segment must not look like a new source. The GENA source-change check compared the
speaker's `CurrentTrackURI` with the session's URL exactly, so the first segment switch would have ended the cast as
`SourceChanged`. It now compares host and stream id, so every segment of a cast is one session, while another app,
another client's cast or the Sonos TV input taking a Playbar over still ends it. Sessions keep the stream's base URL
for their whole life, so a coordinator promoted mid-cast starts on segment 0 and its later segments match too.
Redaction of other clients' stream URLs in Sonos events covers segment URLs as well.
