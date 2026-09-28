---
'@thaumic-cast/core': patch
---

feat(core): log when the network path to a speaker is unstable

Field testing showed the stream to a speaker stuttering exactly when the Wi-Fi between this machine and the speaker
had trouble, while nothing the server measured could see it: the kernel's send buffer hides a stall from the writer.
The server now reads the retransmission, timeout and round-trip counters of the connection each speaker fetches
audio over, on Windows and Linux, into the pipeline snapshot and the end-of-stream summary, warns when data had to be
resent, and judges the link good, degraded or poor over the last minute, logging each change. The verdict is kept
for the speaker monitor, which counts a poor link as a cause when a speaker's head start runs out; it is not sent to
clients, since link trouble the head start rides out needs no telling, and the stream's jitter buffer does nothing
for this link anyway.
