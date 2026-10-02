---
'@thaumic-cast/server': patch
'@thaumic-cast/desktop': patch
---

fix(server,desktop): warn about a key that is not read, and keep the good settings when one is bad

A key in the server's config file that the server does not read, a misspelt one included, used to be dropped without
a word. Each one now gets a warning in the log naming the key and the file, and when it is close to a real key
(`bind_prot`, `pcmConnectBurstMs`) and the file does not have the real key as well, the warning names it and says the
line did not set it. A file whose keys cannot be checked, because one the server does not read is written twice, gets
one line saying so. The server still starts. A bad value for a real key still stops it, as before.

In the desktop app, one unusable value in `settings.json` used to reset all three settings to their defaults. Each
setting is now read on its own: the unusable one takes its default, the others keep their values, and the log says
which one it was and that the next save of any setting replaces it in the file. A key the app does not read is warned
about and ignored, and is gone from the file the next time a setting is saved. A setting written twice in the file
used to count as an unusable file; the later value is now the one used.
