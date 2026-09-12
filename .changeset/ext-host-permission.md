---
'@thaumic-cast/extension': patch
'@thaumic-cast/core': patch
'@thaumic-cast/server': patch
'@thaumic-cast/desktop': patch
---

feat(extension): ask for permission to reach a companion on another machine

When you enter a custom server URL and click Test, Chrome now prompts once to allow that address, scoped to that
origin only. This replaces the companion's CORS layer, which trusted every installed browser extension and wrapped the
API in middleware; the HTTP API no longer sends CORS headers.
