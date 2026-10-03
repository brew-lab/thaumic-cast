---
'@thaumic-cast/desktop': patch
---

feat(desktop): copy a running cast's URL from its speaker card

A casting speaker's card in the Speakers view now has a "Copy URL" button, shown while the cast runs. The URL opens the cast in VLC or a browser, on this computer or another device on your network, through the listen route. It is built afresh from this computer's current address each time, so it stays right after an IP change, and it carries `.wav` for PCM casts and `.flac` for FLAC. The copy starts inside the click, so the macOS and Linux webviews allow it. A note says the player does not keep time with the speakers, and for a PCM cast on Windows a second note warns that with browser-wide capture the browser would cast it back. If the clipboard refuses the URL, it is shown selected for copying by hand.
