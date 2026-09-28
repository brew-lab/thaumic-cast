---
'@thaumic-cast/core': patch
---

fix(core): send each speaker position poll at its dithered moment

The monitor wakes every 500 ms and sent a due poll on the wake-up that noticed it, so every poll landed on that grid and
hit one of two points in the speaker's whole-second position. The random spacing was lost, and the reserve estimate
stalled at about half a second wide instead of narrowing to a few tens of milliseconds, so it never locked. A poll now
waits out the rest of its interval and goes at its own moment.

The dither itself is now a random draw per speaker. It used to be read from the wall clock at the wake-up that sent the
poll, which on the 500 ms wake-up grid took only two values fixed by when the process started, so for some start times
the polls still piled onto a few points in the speaker's second. Each `[SpeakerMonitor]` line now also reports its poll
count and `phase_gap`, the widest stretch of the second its polls left unsampled.
