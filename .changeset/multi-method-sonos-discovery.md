---
'@thaumic-cast/desktop': minor
---

Add multi-method Sonos speaker discovery for improved reliability

- SSDP multicast (standard 239.255.255.250:1900)
- SSDP broadcast (directed per-interface + 255.255.255.255 fallback)
- mDNS/Bonjour (\_sonos.\_tcp.local.)

All methods run in parallel and results are merged with comprehensive UUID normalization. This helps discover speakers on networks where multicast is blocked but mDNS works (common on macOS with firewall enabled).
