---
'@thaumic-cast/extension': patch
'@thaumic-cast/protocol': patch
'@thaumic-cast/ui': patch
---

feat(extension): show speaker notices instead of buffer advice

The popup warned when the path to a speaker was unstable and told the user to raise the network buffer, which cannot
help: that buffer only evens out how audio reaches the desktop app or server, not how it reaches the speaker. The
link-quality warning is gone. The popup now shows the notice the companion decided on for each speaker it is casting
to, worded for where the fix lives: a Wi-Fi stall that outlasted the speaker head start (or nearly did) says how much
audio it held back and which head start would have covered it, then where to change it: the desktop app's Settings >
Speakers, `pcm_connect_burst_ms` in the server's config, or the environment variable that fixes it; a stall no head
start covers suggests moving the speaker or using Ethernet; a speaker running low or being drained by its clock says
so, with restart advice only when a restart would refill it. A dismissed notice stays dismissed while the companion
repeats it and returns only as a new episode or an escalation, and dismissed head-start advice for a speaker is
remembered for 24 hours, so the next cast does not repeat it unless the advice goes higher. Separately, when audio
from the browser reached the companion late often enough to give every speaker a gap, the popup says so and suggests
the smoothing step that would cover it, with a shortcut to the audio settings, unless the capture-health warning
already explains it. The extension keeps the companion's speaker head start and speaker monitor settings current for
this wording. The protocol drops the retired link-quality event and the time to empty, and the shared Alert takes a
translated label for its dismiss button.
