---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
---

Harden streaming network path and diagnostic log retention

Four isolated fixes to the local streaming daemon and desktop app:

**Core (`thaumic-core`):**

- TCP_NODELAY on all accepted connections disables Nagle's algorithm so small PCM frames (1920 bytes) ship immediately instead of being batched, reducing delivery jitter to Sonos.
- TCP keepalive on accepted connections (10s idle, 5s interval, 3 retries on Linux) detects stalled speakers within ~25s instead of the default ~2 hours, preventing async tasks from being held alive on dead connections.
- SSDP discovery now skips link-local (`169.254.0.0/16`) addresses that cause bind failures on adapters like Bluetooth with no real connectivity, and expands the virtual-interface prefix list (Windows `vEthernet`, WireGuard, Tailscale, ZeroTier) that cannot reach local Sonos speakers.

**Desktop:**

- Raises log max file size to 1 MB so pipeline diagnostic dumps survive across sessions without rotation.
