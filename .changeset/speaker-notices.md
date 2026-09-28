---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
---

feat(core): decide speaker notices in the core and drop the jitter-buffer suggestion

The server told clients about every change in a speaker link's quality and suggested a larger jitter buffer, which
cannot help: the jitter buffer only evens out how audio reaches this machine, not how it reaches the speaker. That
event and its suggestion are gone. Instead the speaker monitor decides, at each 30-second report, whether there is
anything to tell the user about a speaker, and the speakerHealth event carries it as `notice`: the speaker head start
ran out (it cut out, and a Wi-Fi stall or a poor link caused it), came close, or ran out when no length would have
been enough; the reserve itself is running low; or the speaker's clock is draining it with less than half an hour to
go. Head-start notices suggest the smallest of 250, 500, 750, 1000, 1500 and 2000 ms above the current setting that
would have covered the stall, and stand for the rest of the cast unless the speaker reconnects with a longer head
start. Each episode keeps its `noticeId` while it is repeated, so a client can dismiss
it once, and gets a new one only on a new episode or an escalation; the same kind starts a new episode at most once
every ten minutes, and advice to restart the cast is only given when a restart would refill the speaker. Separately,
a PCM stream whose smoothing runs dry twice in a minute, which gives every speaker a gap at once, raises an
ingestGaps stream event for its owner, at most once every ten minutes, with the smoothing step that would have
covered the worst gap, or none when no step would. A companionAudioChanged event tells every client the speaker head
start and speaker monitor setting whenever they change; the desktop app sends it when speaker monitoring or the head
start is changed.
