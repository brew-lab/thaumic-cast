---
'@thaumic-cast/desktop': minor
'@thaumic-cast/extension': minor
'@thaumic-cast/protocol': patch
---

Add mDNS service discovery and user-configurable streaming buffer

**mDNS Service Advertisement**

- Advertise Thaumic Cast as `_thaumic._tcp.local.` for native client discovery
- Unique instance name per hostname to avoid conflicts
- TXT records include http_path, ws_path, and version
- Auto-unregisters on shutdown; best-effort if mDNS unavailable

**User-Configurable Streaming Buffer**

- Add streaming buffer setting (100-1000ms, default 200ms) for PCM mode
- Higher values provide more jitter absorption at the cost of latency
- Exposed in extension Audio options panel
- Dynamically derives WAV cadence queue size from buffer setting

**Extension Improvements**

- Skip redundant metadata cache updates for better performance
- Reduce keep-audible gain and optimize PCM conversion
- Add error handling for Zod validation in offscreen handlers
- Post stats during sustained backpressure
- Use interactive latency hint for realtime mode
- Handle WebSocket close during handshake gracefully
- Reject unsupported audio sample rates with clear error

**Architecture**

- Extract thaumic-core crate with Sonos client, stream management, and API layer
- Centralize background task startup and add server IP auto-detection
- Require explicit runtime handle in bootstrap for predictable initialization

**Bug Fixes**

- Align stream URL path with HTTP route
- Align GENA route with callback URL
- Use generic SERVICE_ID for health endpoint discovery
