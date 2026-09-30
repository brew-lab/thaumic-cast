---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

fix(core): keep drift correction steady across a PCM segment switch

Six hours into a cast, when the Playbar moved gaplessly onto the next PCM segment, its reserve seemed to jump from
about 495 ms to about 615 ms, though nothing was heard. A speaker reports its position on the first item it was told to
play slightly ahead of the audio (about 110 ms on a Playbar, 210 ms on a Play:1), and on an item it moves on to by
itself from the audio. Drift correction took the jump for surplus audio, removed it for most of an hour, and dragged its
learned clock rate from +20 to +11 ppm, which would have taken hours to win back.

- **The step is measured and absorbed.** At a switch the monitor measures the reserve on the new segment on its own,
  compares it with the reserve just before, and takes a difference of up to 400 ms off the new segment's readings, so
  the reserve carries on where it was. The log says how big the step was. A bigger step is treated as an underrun, as
  before, and a speaker restarted onto a segment is measured as it always was.
- **Drift correction holds meanwhile.** Until the new segment is measured (about six minutes), and whenever the
  reserve has jumped in a way that may be an underrun, drift correction holds at the clock rate it has learned and
  learns nothing from the jump; the log shows `cmd=...(settle)`. Notices stand as they were during the measurement.
- **A first rough clock estimate no longer moves the reserve.** In the first minutes of a cast the clock rate was
  estimated at -465±161 ppm for a +19 ppm speaker, and even discounted it pushed the reserve up 24 ms and drift
  correction briefly removed audio. The clock rate now only moves the reserve estimate once its error is within 50 ppm.
