---
'@thaumic-cast/core': patch
'@thaumic-cast/extension': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

fix(extension,desktop,server): give four messages the facts they were missing

When Chrome refuses to let a tab be cast, the extension now shows the reason Chrome gave, where it gave one. Before, it
could only say that no reason was written down.

When one speaker drops out of a cast that is still playing on others, the extension now says the cast carries on
without it. It used to show the same line as when the whole cast ended, which for some reasons told you to cast again
while the cast was still running.

In the desktop app, a notice that tells you to turn on clock drift correction now has the "Open Settings" button, as
the notices about the speaker head start already did. With the button there, those notices no longer spell out where
in Settings to look.

Thaumic Cast Server now prints the address to enter in the extension once it is listening, for example "Listening on
port 49400. The extension wants http://192.168.1.20:49400".
