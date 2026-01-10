---
'@thaumic-cast/desktop': patch
---

Optimize ICY metadata injection hot path

- Cache formatted metadata to avoid repeated allocations when metadata unchanged
- Pre-size output buffers based on expected metadata insertions
- Lower per-block logging from info to trace level
