---
'@thaumic-cast/extension': patch
---

fix(extension): let the browser see what a page is playing again

Chrome's media controls, the system's media overlay and the keyboard's media keys read a page's
title, artwork and play state from the browser's media session. The extension's media reader
kept those values for itself instead of passing them on, so the browser saw no title and no play
state. Since the reader started running before each page's own scripts, that covered every page,
YouTube Music included. The reader now passes every value on to the browser and still reads it
for the popup.
