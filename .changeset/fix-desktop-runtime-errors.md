---
'@thaumic-cast/desktop': patch
'@thaumic-cast/extension': patch
---

Fix runtime errors and audio streaming issues

- Fix nested anchor tags in Sidebar causing "improper nesting of interactive content" warnings
- Fix TypeScript types to match Rust backend ZoneGroup structure
- Fix undefined coordinator access causing infinite re-render loop
- Fix AudioWorkletNode not connected to audio graph, preventing audio capture
- Fix codec mismatch in WebSocket handshake causing wrong Content-Type for Sonos
