---
'@thaumic-cast/extension': patch
'@thaumic-cast/desktop': patch
---

fix(extension,desktop): apply the voice pass to the new strings

Some of the wording added with the new popup, settings page and desktop app is plainer now. With
no room chosen, the cast bar says "Choose a room to cast to." The notices for the cast limit, a
cast already running, an old companion, a speaker that dropped off and an address that gave
nothing usable say what happened in fewer words. A saved set with a missing room reads "Kitchen is
not answering, so only Den plays." The popup's setup counts rooms, as the desktop's does. The
desktop's copy field says "Copying did not work" when the clipboard refuses. Every "Try again"
button now uses one string per app.
