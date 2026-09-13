---
'@thaumic-cast/extension': patch
---

fix(extension): keep audio frames in order when the connection is congested

In quality mode a newly encoded frame was sent as soon as the socket drained, even while older frames were still
queued, so the server could receive audio out of order. Queued frames are now always drained first, including for the
underflow ramp and the final flush at the end of a cast. Realtime mode is unchanged.
