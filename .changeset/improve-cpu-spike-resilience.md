---
'@thaumic-cast/desktop': patch
---

Improve resilience to CPU spikes during audio streaming

- Increase broadcast channel capacity from 100 to 500 frames (~10 seconds of buffer instead of ~2 seconds), allowing HTTP clients to absorb longer delivery delays without disconnecting
- Increase WebSocket heartbeat timeout from 10 to 30 seconds, reducing spurious disconnects during system-wide CPU contention
