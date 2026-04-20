---
'@thaumic-cast/protocol': patch
'@thaumic-cast/core': patch
'@thaumic-cast/extension': patch
'@thaumic-cast/desktop': patch
---

Rename `streamingBufferMs` setting to `jitterBufferMs` across the stack

Pure rename — no behavior change. Every value, default, clamp range, and UI option stays the same. Identifier updated on the protocol, core, extension, and desktop surfaces, plus docstrings and the one user-facing label ("Streaming Buffer" → "Jitter Buffer"). The setting has always functioned as a jitter buffer (holding PCM frames to smooth WebSocket-to-Sonos delivery variance), so the name now matches the role.

Sets up a follow-up change that turns this from a passive sizing hint into an active fill-gate / refill-on-underrun state machine.
