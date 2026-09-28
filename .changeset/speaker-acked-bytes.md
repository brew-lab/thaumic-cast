---
'@thaumic-cast/core': patch
---

feat(core): read acked bytes from the speaker socket

The reserve estimate counts delivered audio as what the response body has yielded, which runs ahead of what the
speaker holds whenever the socket backs up, so a retransmission stall that briefly empties the speaker never showed in
it. The TCP statistics read every 500 ms now include the bytes the speaker has acknowledged, counted from when the
stream claims the connection so earlier responses on a kept-alive socket are left out: on Linux from a `tcp_info`
prefix whose later fields are trusted only when the length the kernel returns covers them, on Windows as bytes sent
less bytes in flight, net of retransmissions once a connection shows this machine's stack counting them (an excess the
resent bytes do not explain is reported as unknown, never learned from). Each pipeline snapshot carries the bytes not
yet acknowledged, and the speaker monitor takes the lowest reserve, the projected time to empty and a new `low` alarm
on acknowledged audio: a speaker whose acknowledged reserve spends a tenth of a 30-second window 150 ms below the
level it settled at (learned on the same acknowledged basis, so a steady lag cancels, and not tripped by a single
retransmission dip) is warned about and shown as `state=low` until it recovers to within 50 ms or reconnects. The
30-second line shows the acknowledged minimum and 10th percentile beside the target, and platforms without
acknowledgements fall back to the delivered count.
