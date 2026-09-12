---
'@thaumic-cast/core': patch
'@thaumic-cast/server': patch
'@thaumic-cast/desktop': patch
---

build(deps): update Rust dependencies

Bumps 26 crates, notably quick-xml 0.39 → 0.41, mdns-sd 0.19 → 0.20 and tower-http 0.6 → 0.7, and adapts the XML
text readers to quick-xml's new `BytesText` return type. No behaviour change.
