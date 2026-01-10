---
'@thaumic-cast/desktop': patch
---

Reuse scratch buffer in ICY metadata injection to reduce allocation pressure

- Replace per-chunk Vec allocation with reusable BytesMut buffer
- Buffer grows to typical chunk size and stabilizes after a few calls
- Reduces allocator churn on long audio streams
