---
'@thaumic-cast/core': patch
---

fix(core): keep a locked speaker reserve locked through ordinary widening

A speaker's reserve estimate locked and unlocked on the same test, so a few lost polls or an unlucky spread of poll
phases widened it past about 110 ms and dropped the lock, and the monitor went back to `state=locking` on a speaker
that was fine. The lock is now strict to acquire and loose to hold: once locked, an estimate stays locked up to 200 ms
wide while its window holds at least 30 polls, and the lock drops only after two estimates in a row fail that, or at
once on a segment break. Only estimates as narrow as acquiring needs set the underrun-step baseline and the level the
low-reserve alarm is measured from, and the step threshold never counts more width than acquiring allows, so a held
estimate cannot hide a real underrun. Each `[SpeakerMonitor]` line reports `lock=` (acquired, tight, held or
unlocked), and the monitor warns once when so many speakers share its poll budget that none of them can hold a lock.
