---
'@thaumic-cast/core': patch
---

feat(core): estimate speaker reserve and clock rate from RelTime bounds

The old cushion figure subtracted the speaker's whole-second RelTime from wall-clock time since the epoch, so it
counted our own cadence queue as audio the speaker held and jittered by several hundred milliseconds between polls: a
reading of 200 ms could mean the speaker was already empty. Each poll of a PCM connection now bounds the speaker's
true reserve, audio delivered minus audio played, to within a second, and the last three minutes of dithered polls
narrow that to a few tens of milliseconds, trimmed against stray answers and widened by a learnt allowance for RelTime
tick jitter. The speaker's clock rate against ours is fitted from its playhead alone, so audio inserted later to
compensate cannot bias it, and jointly over every stretch of unbroken playback, so a speaker that refetches the stream
every few minutes still gets an honest error. Every 30 seconds one `[SpeakerMonitor]` line per speaker reports the
reserve, the clock rate, a drain projection, poll rate, jitter, the cadence queue, delivery gaps and retransmissions;
a speaker whose reserve is draining (see the reserve floor entry) is warned about once and shown as `state=draining`,
and a jump in the reserve that looks like an underrun is warned about too. Each connection ends with a summary line,
and the pipeline timeline carries the reserve and clock too. The wall-clock cushion line remains only for compressed
codecs, whose byte counts say nothing exact about playback time.
