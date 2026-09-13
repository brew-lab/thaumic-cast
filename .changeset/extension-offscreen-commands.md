---
'@thaumic-cast/extension': patch
---

fix(extension): send each speaker command once and clean up slow cast starts

Volume and mute changes from the popup reached both the background worker and the audio document, so each command was
sent to the server twice. Messages intended for the audio document now carry a marker and anything else is ignored.
A cast start that took longer than the background timeout also left the tab captured and the speakers playing with no
session to stop; long operations now get a longer timeout and the failure path stops the session.
