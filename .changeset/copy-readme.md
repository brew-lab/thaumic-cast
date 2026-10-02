---
'@thaumic-cast/server': patch
---

docs(server): rewrite the README and the server's README

The project README and the server's README, which ships in the release tarball, have been rewritten in the same words
the apps now use: cast, speaker head start, reserve, speaker monitoring, clock drift correction. Commands, options and
defaults are unchanged, and so are the tables, apart from a few descriptions that now use those words. The server's
README now gives the extension's settings path as it appears on screen (Settings → Companion → Enter the address), says
that adding a speaker by IP address needs `data_dir`, and lists what the server actually does when it is asked to
stop.
