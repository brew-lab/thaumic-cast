---
'@thaumic-cast/extension': patch
---

fix(extension): ignore topology event types this build does not use

The companion now sends a memberChanged topology event when a satellite drops off or a device reboots. The extension
validated every topology event as a group discovery, so each new one failed validation and logged an error. Topology
events of other types are now accepted and ignored at debug level, as network events already were.
