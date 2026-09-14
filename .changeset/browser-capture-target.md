---
'@thaumic-cast/extension': patch
'@thaumic-cast/desktop': patch
---

fix(extension): capture the browser that is casting, not the one that started first

Browser-wide capture attaches to one browser's process tree, and the extension never said which browser it was, so
the companion captured whichever supported browser had the lowest process id. On a machine where another browser sat
in the background that was the wrong one, and the result was a perfectly timed stream of silence. The extension now
names its own browser, using the client-hint brands where the user agent string would disguise it, and the companion
falls back to auto-detection with a warning if that browser is not found, logging every candidate when it has to guess.
