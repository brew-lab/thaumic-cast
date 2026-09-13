---
'@thaumic-cast/core': patch
'@thaumic-cast/server': patch
---

feat(core): serve an audio stream only to the speakers it is for

A stream identifier is not private. The server gives the stream address to the speaker, and the speaker reports it to
anything on the network that asks, which this codebase does itself when reading what a speaker is playing. Each
request now works out which addresses that stream is for, from the sessions it actually has plus the machine running
the server, and compares them consistently so an address written in either form still matches. Working this out per
request rather than recording one address covers speakers joining, leaving, being taken over and being promoted, which
matters because an unsynchronised cast has every speaker fetching separately.

This ships observing rather than enforcing. The `strict_stream_access` option defaults to off, so every request is
served exactly as before and unexpected addresses are logged with the stream and the addresses that were expected.
Turn it on once the logs from a real setup show nothing unexpected, because a wrongly refused request is silence with
nothing to see. Only the headless server exposes the option; the desktop app keeps the default. Refused requests answer
not-found, the same as an expired stream. A separate limit bounds simultaneous readers that are not on the list, since
each one starts its own pipeline; speakers the stream is for are never counted against it, and readers that are not
speakers are kept out of the per-speaker playback tracking so they cannot disturb a real speaker's reconnects. One
known gap once enforced: a speaker whose address changes mid-cast is refused until playback is restarted.
