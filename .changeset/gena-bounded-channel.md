---
'@thaumic-cast/desktop': patch
---

Use bounded channel for internal GENA events to prevent unbounded memory growth

- Replaced unbounded channel with bounded channel (capacity 64)
- Events are dropped with a warning if channel fills (safe since all trigger same recovery)
- Prevents theoretical memory growth if receiver stalls during event spikes
