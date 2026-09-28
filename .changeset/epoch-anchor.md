---
'@thaumic-cast/core': patch
---

fix(core): anchor the playback epoch to the first frame served

A speaker's playback epoch, the capture time its RelTime 0 corresponds to, was taken from the oldest frame in the
stream's 500 ms ring, but the PCM cadence serves only the newest jitter buffer's worth of that ring. Whenever the ring
was full when the speaker connected, which is any fetch arriving more than half a second after audio started and every
reconnect, the epoch sat up to 300 ms before the first frame the speaker actually played, so every latency and cushion
measured on that connection read up to 300 ms too high. The epoch is now the capture time of the first frame kept
after trimming. Reported video-sync latency drops by the same amount; that is a correction, not a regression.
