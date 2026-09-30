---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

fix(core): never advertise the Cloudflare WARP address at launch

With Cloudflare WARP connected on Windows, the desktop app started up advertising WARP's tunnel address
(100.96.x.x) and corrected it to the LAN address only once the first discovery found the speakers, about 5 s
later. Nothing was cast in that window, but the address was announced over mDNS and shown on the Server
page, the log warned "Local IP changed" on every launch, and discovery tried to broadcast on the WARP adapter
every 30 s and logged three failures each time.

- WARP's adapter (`CloudflareWARP`) is now filtered like other VPN adapters, for address choice and for
  discovery.
- An address in 100.64.0.0/10, the range WARP and Tailscale give their adapters, no longer wins just because it
  owns the default route, so a VPN under an adapter name we do not know is passed over too. A machine whose only
  address is in that range still advertises it.
