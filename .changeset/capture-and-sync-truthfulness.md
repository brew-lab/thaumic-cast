---
'@thaumic-cast/extension': patch
'@thaumic-cast/protocol': minor
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

fix(extension,core): disable capture, keep-awake and video sync controls where they cannot act

The companion now says whether it can capture the whole browser for the extension asking, and the Settings page uses
the answer. Against a server, or a desktop app on another machine, Browser-wide capture can no longer be turned on and
says why. If it is already on, it stays visible and can always be unticked, with a line saying a cast will not start
until it is. It is hidden only when it is off and the companion is a server. With no companion connected, or one too
old to say, the control is as it was.

Keep the tab awake is disabled under browser-wide capture, where it does nothing, and says so; the choice is kept.

Video sync controls appear in the popup only on a cast that was started with Video sync controls turned on. Turning
the setting on during a cast used to show controls that never locked; the setting now says a change applies from the
next cast.

Choosing "Specify manually" for the server without a saved address now shows a line saying no address is saved and
that the extension is still looking on this machine, instead of nothing.

No stored setting or default has changed.
