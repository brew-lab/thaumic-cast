---
'@thaumic-cast/desktop': minor
---

Extract core streaming logic into thaumic-core crate

**Architectural Refactor**

Extract the core Sonos streaming logic from the desktop app into a standalone Rust library (`packages/thaumic-core`). This enables:

- Headless server deployments without Tauri/GUI dependencies
- Shared code between desktop app and standalone server
- Cleaner separation of concerns

**New Abstractions**

- `EventEmitter` trait: Pluggable event dispatch (Tauri events, WebSocket broadcast, etc.)
- `Context`: Shared application state with runtime handles
- `StreamingRuntime`: Dedicated high-priority runtime for audio streaming
- `bootstrap_services()`: Unified service initialization

**Modules Migrated**

- Sonos client, discovery (SSDP/mDNS), GENA subscriptions
- Stream manager, WAV/ICY formatters, transcoder
- HTTP API routes, WebSocket handlers
- All background services (topology monitor, latency monitor, etc.)

The desktop app now depends on thaumic-core and provides only Tauri-specific glue code.
