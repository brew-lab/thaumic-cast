---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

fix(core): log a grouped member's grace ending at debug when it still plays

After every grouped gapless switch the log said a speaker joined to the coordinator "did not report PLAYING within
5000 ms". Members report nothing at all through a gapless switch and their recorded state stays PLAYING, so that is
the normal path: it is now logged at debug, and at info only when the state clients are then shown is not PLAYING
(STOPPED after a restart, say). The line names that state. The member is released after the grace as before.
