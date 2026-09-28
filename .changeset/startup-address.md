---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

fix(core): advertise the speakers' LAN address from the first discovery

At launch nothing has been discovered, so the advertised address is chosen from the interface list alone, and on a
machine whose default route runs through a VPN adapter the name filter does not recognise (Cloudflare WARP on Windows)
it is the tunnel's. Detection only ran again at the top of the next refresh, so the first round of GENA subscriptions,
and any cast started in the meantime, were built on an address no speaker could reach. Detection now re-runs against
the speakers as soon as discovery finds them, before the groups are published or anything is subscribed. Playback
also moves the address onto the target speakers' subnet when it is on none of them and a detected address is, and a
SUBSCRIBE rejected with 412 is retried once with a corrected callback. An explicitly configured address is never
changed, and with no speakers known the launch choice is unchanged.
