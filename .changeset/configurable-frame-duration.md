---
'@thaumic-cast/extension': minor
'@thaumic-cast/protocol': patch
---

Add configurable frame duration setting for PCM streaming

- Add `frameDurationMs` field to encoder config (10ms, 20ms, or 40ms)
- Expose Frame Duration dropdown in extension Audio settings (PCM only)
- Display frame duration in "What You're Getting" resolved settings
- Default remains 10ms for low latency; larger values improve stability on slow networks
- Field named generically for future extension to other codecs
