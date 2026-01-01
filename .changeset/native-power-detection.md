---
'@thaumic-cast/desktop': minor
'@thaumic-cast/extension': minor
---

Add native power state detection and battery-aware audio config

- Desktop app now detects system power state using native OS APIs (starship-battery)
- Power state is sent to extension via WebSocket, bypassing browser Battery API limitations
- Extension automatically selects lower-quality audio config when on battery to prevent audio dropouts
- Added audio pipeline monitoring to detect silent failures and source starvation
- Session health tracking reports audio drops for config learning
