---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

fix(core): let drift correction learn a speaker's clock from its measured rate

Drift correction learned how fast a speaker's clock runs slowly, from the reserve alone: on the Playbar (+19 ppm) it
had learned +6.7 ppm after half an hour and +12.9 after an hour, and it took three hours to get there. Meanwhile the
reserve sat off its level (on a Play:1 about 45 ppm slow, 80-100 ms high) and the correction was busier than it needed
to be. The monitor measures the same clock rate directly, and after 35-45 minutes of an unbroken cast that measure is
good to within 10 ppm.

From then on each reserve estimate also draws the learned rate a little way towards the measured one, never more than
0.5 ppm at a time: the more precise the measurement and the less the correction has learned about the speaker yet, the
further. In simulation, over casts to speakers from 60 ppm fast to 45 ppm slow, the learned rate is a median 2.8 ppm
off an hour in, where it was 10.5, and the reserve settles within 40 ms of its level about 20 minutes sooner and
overshoots it less. A speaker the correction has already learned during an earlier cast is barely moved. With
10-minute test segments the measured rate stays too uncertain to use, and nothing changes.
