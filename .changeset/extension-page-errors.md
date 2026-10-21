---
'@thaumic-cast/extension': patch
---

fix(extension): stop the errors chrome://extensions showed on YouTube Music

On YouTube Music the extension could not read what was playing or control it. The content scripts
were loaded from the page as modules, and YouTube Music's Connection-Allowlist blocks those loads
("Unsafe attempt to load URL ..."). They are now plain scripts the browser injects itself, so no
page can block them, and they run before the page's own scripts, so none of its media session
calls are missed.

A tab left open while the extension reloads or updates no longer reports "Extension context
invalidated": its old content script now stops quietly. The companion quitting, restarting or
going to sleep is no longer logged as a warning, since the extension reconnects by itself. It
warns only if it gives up.
