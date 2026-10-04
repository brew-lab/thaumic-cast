---
'@thaumic-cast/core': patch
'@thaumic-cast/protocol': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

feat(core): tell video sync how long a PCM cast's audio takes to reach the speaker's playhead

With video sync on, the companion now sends an estimate with each latency update of how long audio takes from
reaching it to being played by the speaker: the time it waits in the companion's queue plus the speaker's reserve, the
audio it has been sent and not played yet. Until the reserve is measured, which takes a minute or three, the estimate
uses the head start the speaker was sent plus where that speaker settled on its past casts. The estimate carries a
number that changes only when the figure may have jumped (a new connection, the switch from the head start guess to
the measured reserve, or a break in the measurements), so the extension can tell a real step from everyday wobble.
After a break it goes back to the head start guess until the reserve is measured again.
It is sent only for PCM casts, the only ones whose reserve is measured. The extension does not use it yet.

The latency figure video sync already received was one network round trip too low, about 5 to 50 ms, because half
the round trip was added to the wrong side. It is now right, which raises that figure and the cushion line in the log
for compressed casts by the same amount. With debug logging on, video sync casts also log the estimate every 30
seconds under `[VideoSync]`; the `[SpeakerMonitor]` lines do not change.
