---
'@thaumic-cast/core': patch
'@thaumic-cast/protocol': patch
---

feat(core): tell clients when the network path to a speaker is unstable

Field testing showed the stream to a speaker stuttering exactly when the casting machine's Wi-Fi had latency
spikes, while nothing the server measured could see it: the kernel's send buffer hides a stall from the writer. The
server now judges the path to each playing speaker from the round trips of its own position polls, the same probe
as a ping, and broadcasts a link quality of good, degraded or poor on every change, with the median and worst round
trip and the spike and failure counts over the last minute. It also reads the retransmission counters of the
connection each speaker fetches over, on Windows and Linux, into the pipeline snapshot and the end-of-stream summary,
and warns when data had to be resent, so a stall shows in the log beside a delivery window that looks perfect.
