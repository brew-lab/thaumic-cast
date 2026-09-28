---
'@thaumic-cast/core': patch
---

fix(core): send each speaker position poll at its dithered moment

The monitor wakes every 500 ms and sent a due poll on the wake-up that noticed it, so every poll landed on that grid and
hit one of two points in the speaker's whole-second position. The random spacing was lost, and the reserve estimate
stalled at about half a second wide instead of narrowing to a few tens of milliseconds, so it never locked. A poll now
waits out the rest of its interval and goes at its own moment.
