---
'@thaumic-cast/desktop': patch
---

Use allocation-free ASCII case-insensitive parsing for SSDP responses

- Eliminates multiple string allocations per response during discovery burst
- Uses byte-level comparison instead of to_lowercase()
- Improves discovery performance on networks with many speakers
