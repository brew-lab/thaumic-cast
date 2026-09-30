---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

fix(core): blame the clock, not Wi-Fi, when drift drained a speaker that then ran out

Six hours into a cast the Playbar's clock (+19.3 ppm) had drained its reserve from about 510 ms to about 83 ms. One
acknowledgement lag of about 88 ms on its always-poor link then put the acknowledged reserve at -5 ms, and the speaker
was told "Wi-Fi trouble held back 505 ms of audio" with a 750 ms head start as the fix. Both were wrong: 505 ms was the
head start less the minimum, most of it taken by the clock over hours, and a longer head start drains the same way.

- **Drift first.** A speaker whose clock drained at least half of what its reserve lost before a stall came, by the
  rule running low's drift cause uses and judged from the reserve's median rather than a minimum the stall pulled down,
  gets no head-start notice for a stall that runs it out, whether or not the reserve was below the floor yet. Running
  low, with `cause: "drift"`, says what happened and offers drift correction and a restart. An underrun seen only as
  an offset step is judged the same way from the window before the break, when that was already running low.
- **Unless the stall alone was too much.** A stall that would have run the speaker out from a full reserve too (more
  than the head start less its floor) is still a head-start notice, and on a drift-drained speaker it reports the
  stall measured, never the head start less the minimum.
- **A poor link no longer hides the drift.** Running low's drift cause no longer requires a good link: a speaker whose
  link is always lossy drifts like any other, and a poor link alone never turns a drift-drained reserve into a Wi-Fi
  notice.

A thin reserve hit by a loss burst the clock does not explain (the 2026-09-28 Playbar underrun) is a head-start notice
as before.

A standing notice that gains its cause in place is now logged, under the same id.
