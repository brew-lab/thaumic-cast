---
'@thaumic-cast/extension': patch
---

Migrate extension settings from sync to local storage and add privacy policy

- Switch from `chrome.storage.sync` to `chrome.storage.local` for all extension settings
- Add one-time migration to preserve existing user settings
- Add PRIVACY.md documenting data handling practices
