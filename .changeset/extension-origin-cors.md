---
'@thaumic-cast/core': patch
'@thaumic-cast/server': patch
'@thaumic-cast/desktop': patch
---

fix(core): allow the extension to reach a companion on another machine

The extension only has host permission for `localhost`, so every request to a remote headless server was blocked by
CORS. The HTTP API now answers CORS for `chrome-extension://` and `moz-extension://` origins only; regular web pages
remain unable to read responses.
