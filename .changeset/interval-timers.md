---
'@thaumic-cast/desktop': patch
---

Use tokio interval instead of sleep for timer loops

- Reduces timer allocation overhead in WebSocket heartbeat and latency polling
- Prevents timing drift by compensating for processing time
