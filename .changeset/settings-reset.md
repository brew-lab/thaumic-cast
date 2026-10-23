---
'@thaumic-cast/extension': minor
'@thaumic-cast/desktop': minor
---

feat: reset all settings to their defaults

The extension's options page and the desktop app's Settings end with a Reset section: "Reset all settings" asks
first, then puts every setting back to its default. The connection stays as it is, so a reset never disconnects: the
extension keeps the companion's address and how it is found, and the desktop keeps the server's address and ports
and the speakers added by IP address. Saved sets, one-time notices and onboarding are not settings and are left
alone. Each setting is saved as it is when changed by hand, so the theme changes at once, the desktop's launch at
login is turned off through the system, and the speaker and audio settings apply from the next connection or cast.
Reset is disabled while every setting is already at its default.
