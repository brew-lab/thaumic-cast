---
'@thaumic-cast/extension': patch
---

Use adaptive backoff for backpressure handling in audio consumer worker

- Reduces CPU spinning during sustained backpressure from ~1000 wakeups/sec to ~25 wakeups/sec
- Exponential backoff: 5ms → 10ms → 20ms → 40ms (capped) while backpressured
- Recovers quickly when pressure eases by resetting consecutive cycle counter
