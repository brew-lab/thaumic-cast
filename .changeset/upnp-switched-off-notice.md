---
'@thaumic-cast/extension': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/protocol': patch
---

feat(extension,desktop): tell the user to switch Sonos UPnP back on

When the Sonos app's UPnP switch is off, the popup's banner, the toolbar badge and the desktop app now say so and name
the setting (Account > Privacy & Security > Connection Security > UPnP), instead of blaming a VPN or a firewall. A cast
the speakers turn away for the same reason says the same.
