---
'@thaumic-cast/extension': patch
'@thaumic-cast/ui': patch
---

Fix SoC and DRY violations across extension and UI packages

**Extension:**

- Fix connection state sync after service worker wake-up
- Unify connection state to single source of truth
- Centralize discovery/connection logic in background
- Centralize stop-cast cleanup in stopCastForTab
- Move i18n translations to presentation layer
- Use validated settings module for init functions
- Extract codec cache to shared module

**UI:**

- Remove hardcoded English defaults from ActionButton labels for i18n support
