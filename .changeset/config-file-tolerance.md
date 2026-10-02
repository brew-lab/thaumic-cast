---
'@thaumic-cast/server': patch
'@thaumic-cast/desktop': patch
---

fix(server,desktop): warn about a key that is not read, and keep the good settings when one is bad

A key in the server's config file that the server does not read, a misspelt one included, used to be dropped without
a word. Each one now gets a warning in the log naming the key and the file, and when it is close to a real key
(`bind_prot`, `pcmConnectBurstMs`) the warning names that key too. The server still starts. A bad value for a real key
still stops it, as before.

In the desktop app, one unusable value in `settings.json` used to reset all three settings to their defaults. Each
setting is now read on its own: the unusable one takes its default, the log says which, and the others keep their
values. A key the app does not read is warned about and ignored, and is gone from the file the next time a setting is
saved.
