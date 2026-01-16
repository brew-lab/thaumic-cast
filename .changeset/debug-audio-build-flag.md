---
'@thaumic-cast/extension': patch
---

Optimize production performance by eliminating debug-only overhead

- Add `__DEBUG_AUDIO__` build-time flag for audio diagnostics (enabled in dev, eliminated in prod)
- Guard per-sample clipping detection with build flag, removing ~192k/sec overhead in production
- Increase stats posting interval from 1s to 2s to reduce message-passing load on low-end devices
