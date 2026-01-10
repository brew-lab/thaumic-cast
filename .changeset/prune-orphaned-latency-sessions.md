---
'@thaumic-cast/desktop': patch
---

Fix latency session leak when WebSocket handler exits unexpectedly

- Prune orphaned sessions during poll loop when stream no longer exists
- Prevents sessions from being polled indefinitely after unexpected disconnects
- Defense-in-depth cleanup for StreamGuard::drop edge cases
