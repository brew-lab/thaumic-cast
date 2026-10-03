---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
---

chore(deps): update the Rust dependencies, including quick-xml 0.42 and Tauri 2.12

Takes the Rust updates dependabot proposed in #188 (tokio, reqwest, serde_json, mdns-sd 0.21, uuid, thiserror, Tauri 2.12 and its plugins, and others), and moves the Sonos XML parsing to quick-xml 0.42, which reads element names, attributes and text as UTF-8 strings rather than bytes. The parsed results are the same; the only difference is that a speaker reply that is not valid UTF-8 is now rejected rather than read with replacement characters. `windows-core` stays at 0.62 to match the `windows` crate.
