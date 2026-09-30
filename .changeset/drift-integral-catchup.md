---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

fix(core): let drift correction learn a speaker's clock from its measured rate

Drift correction learned how fast a speaker's clock runs from the reserve alone, slowly: on the Playbar (+19 ppm) it had
learned +6.7 ppm after half an hour and +12.9 after an hour, and reached about +18.4 at 93 minutes and +20.4 at 103.
Meanwhile the reserve sat off its level (on a Play:1 about 45 ppm slow, 80-100 ms high) and the correction was busier
than it needed to be. The monitor measures the same clock rate directly, and after 35-45 minutes of an unbroken cast it
claims a standard error under 10 ppm.

From then on each reserve estimate also draws the learned rate a little way towards the measured one, never more than
0.5 ppm at a time, so a 20 ppm gap takes about 20 minutes to close: the more precise the measurement and the less the
correction has learned about the speaker yet, the further. The measured rate's standard error says how much it
scatters, not how far off it is, and late in a cast it claims too little (the Playbar's claimed ±0.5 ppm while it moved
by 3.5), so it counts as no better than ±3 ppm. A measurement over less than 30 minutes draws nothing. The monitor line
shows how long the correction has learned the speaker and how far the measurement drew it on each report
(`I=+17.7 taught=93m pull=+0.12ppm`).

In simulation, over casts to speakers from 60 ppm fast to 45 ppm slow, the learned rate is a median 3.2 ppm off an hour
in, where it was 10.8, and the reserve settles within 40 ms of its level about 20 minutes sooner. On the speakers that
drift, it overshoots its level after the first half hour by a median 4.2 ms where it did by 10.2 (90th percentile 13
where 19). Not every cast gains: about 5% of casts to a new speaker overshoot a little more than they did, by up to
9 ms, and about 10% of those to a speaker the correction has partly learned already, by up to 10 ms. A speaker the
correction has learned during an earlier cast is barely moved. With 10-minute test segments the measurement is precise
by the hour and the same holds.

A switch away from the item the speaker was told to play now always restarts the clock measurement, as it did only
after an item of three minutes or more: after a two-minute first item the reporting step left in the measurement put it
a mean 10-12 ppm off at 40 minutes in simulation, just as it starts to draw the learned rate.
