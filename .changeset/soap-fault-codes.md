---
'@thaumic-cast/core': patch
---

fix(core): read the error code from Sonos SOAP faults

A Sonos speaker reports every fault with the same `faultstring` and puts the meaning in the fault detail, but the
code was being looked for in the faultstring, so it was never found. As a result a speaker answering "transition not
available" while it changed states was treated as a hard failure instead of being retried, and a stop sent to a
speaker that had already stopped was reported as an error. The code is now read from the detail, retries happen on the
transient codes as intended, and an already-stopped speaker counts as stopped.
