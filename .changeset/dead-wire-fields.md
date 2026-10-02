---
'@thaumic-cast/extension': patch
'@thaumic-cast/protocol': patch
'@thaumic-cast/core': patch
---

refactor(extension,protocol): stop sending fields the companion never reads, and remove reconfigure()

Internal tidying; nothing a listener can see or hear changes. When a cast starts, the extension no longer sends the
companion its frame duration and latency mode. The companion reads neither: it works the frame duration out from the
frame size, and the latency mode only steers the extension's own encoder. Both settings are stored and used in the
extension as before. An encoder method that nothing called is gone. New tests hold the extension and the companion to
the same smoothing, frame duration and speaker head start limits, and to the same handshake.
