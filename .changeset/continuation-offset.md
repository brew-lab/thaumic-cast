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
  before, and a speaker restarted onto a segment is measured as it always was. A switch that follows an underrun by a
  few minutes is not measured, so the underrun is still reported.
- **Later switches absorb nothing.** Only the first switch after the speaker was told to play has an offset. Later
  switches are still measured, and a step over 150 ms is still an underrun, but a smaller one is logged as steady and
  left alone: absorbing each one's measuring error had added up and drifted the reading. In the field the later
  switches all read slightly negative (-5 to -17 ms); whether that is real or how the speaker reports is not yet
  known. This only matters with short test segments.
- **Drift correction carries on meanwhile, without the step.** Until the new segment is measured (about six minutes),
  drift correction steers by the reserve from before the switch, carried on along the speaker's clock, which has none
  of the step in it; the log shows `cmd=...(carried)`. Whenever the reserve has jumped in a way that may be an
  underrun, it holds at the clock rate it has learned, at once, and learns nothing from the jump
  (`cmd=...(settle)`). Notices stand as they were during the measurement. On a link too poor to measure the new
  segment within 15 minutes, the reserve is reported as read again, and drift correction holds until the step is
  measured. With 10-minute test segments, where a switch is being measured six minutes in every ten, drift
  correction now holds a slow speaker's reserve within about 30 ms (RMS) of its level from 100 minutes on in
  simulation, where holding through every measurement had left it hundreds of milliseconds off after hours.
- **Short segments keep an accurate clock.** The clock estimate no longer starts over at every later switch, which
  with 10-minute segments had left it tens of ppm off after hours. A first switch measured before the clock is known
  is corrected once it is, which takes out about 17 ms of average error on a 45 ppm speaker.
- **A first rough clock estimate no longer moves the reserve.** In the first minutes of a cast the clock rate was
  estimated at -465±161 ppm for a +19 ppm speaker, and even discounted it pushed the reserve up 24 ms and drift
  correction briefly removed audio. The clock rate now only moves the reserve estimate once its error is within 50 ppm.
