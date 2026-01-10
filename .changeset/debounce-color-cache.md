---
'@thaumic-cast/extension': patch
---

Debounce dominant color cache persistence

- Refactored to use DebouncedStorage utility for consistency with other caches
- Cache writes are now debounced (500ms) instead of firing on every extraction
- Reduces chrome.storage.session.set calls during rapid image changes
