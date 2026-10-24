---
'@thaumic-cast/core': patch
---

fix(core): recognise a Sonos household with UPnP switched off

With the Sonos app's Account > Privacy & Security > Connection Security > UPnP switch off, every speaker answers
control and event requests with a bare 403. That was reported as speakers not responding, which blames a VPN or a
firewall. The refusal is now its own error, never retried, and sets the network health reason
`speakers_upnp_disabled`; a cast started meanwhile fails each room with the same word. A change of reason alone is
now sent to clients too, and the notice clears on the first refresh after the switch goes back on.
