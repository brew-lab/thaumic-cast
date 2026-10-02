---
'@thaumic-cast/extension': patch
'@thaumic-cast/desktop': patch
---

fix(extension,desktop): show a proper message where a code or the wrong text showed

A few messages appeared as an internal code, such as `error_offscreen_unavailable`, when a cast failed to start. They
now read as sentences. Adding a speaker by IP address in the desktop app always gave the same vague line; it now says
whether the address could not be reached, is not a Sonos speaker, or is not an IP address at all.

On Mac and Linux the extension no longer recommends browser-wide capture when audio is dropping, since that setting
only exists on Windows, and the desktop app's first-run screens no longer flash the Windows wording before showing
your platform's. When a speaker cut out because its head start had already been used up, the notice no longer claims
the Wi-Fi delay was longer than the head start.

Counts now read correctly for one: "1 speaker", "+1 other", "late 1 time". The button on a connection error reads
"Try again" when nothing was found and "Reconnect" only when a connection was lost. The tray tooltip after Stop All
Streams is two plain sentences, and appears only when a cast from another machine was stopped. A settings or
codec-detection failure in the extension now shows its translated message, not the raw error.
