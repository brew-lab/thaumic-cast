---
'@thaumic-cast/desktop': patch
---

fix(desktop): prevent theme flash on app startup

- Start window hidden and show after frontend initialization
- Add inline theme initialization in HTML to apply correct theme before CSS loads
- Respect --minimized flag for tray-only startup mode
