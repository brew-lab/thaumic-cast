---
'@thaumic-cast/core': patch
---

feat(core): judge a low speaker against a floor sized from its head start

The low-reserve alarm compared a speaker's acknowledged reserve with the level it settled at, so a speaker that
settled at 500 ms and dipped to 350 ms was called low, while one that started a cast with the speaker head start off
and next to nothing in hand never was. A speaker is now low when its acknowledged reserve's 10th percentile over a
30-second window falls below an absolute floor sized from the head start its connection was actually sent
(clamp(0.3 x head start, 40, 150) ms: 150 ms at the default 500 ms, 40 ms with the head start off), and it recovers
once it regains the floor plus clamp(0.2 x head start, 30, 100) ms. Each connection records the head start it was sent
beside the one configured, which differ when the stream held too little audio when the speaker connected. The drain
projection is now a time to that floor rather than to empty, at the clock rate shrunk by its uncertainty so a rate
pooled from a few short segments cannot put a speaker hours from the floor inside the warning window, and a speaker is
reported draining when that is under 30 minutes. Acknowledgement lag is also sampled on every monitor tick, so a stall
long enough to stop the connection's own snapshots is still seen, and each window reports its stall: the worst lag
less the median, which leaves out what is steadily in flight. The level a connection settles at is now learned per
connection, from its first two tight estimates, and logged against its head start as `calib`; the acknowledged
reserve from before a segment break is kept for judging what led up to it. Each `[SpeakerMonitor]` line reports
`H=`, `Hcfg=`, `floor=`, `clear=`, `stall=`, `ttf=`, `calib=`, `link=` and how far the reserve has `dropped=`, and the
speakerHealth event carries the head start sent and configured, the floor, the stall and the time to the floor in
place of the time to empty.
