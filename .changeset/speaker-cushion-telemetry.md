---
'@thaumic-cast/core': patch
---

feat(core): log each speaker's playback cushion and its trend

Every playing speaker is now polled for its playback position, not only when video sync asks for it, and the log
gets a line every ten seconds with how much audio the speaker holds ahead of its playhead and how that figure is
trending. A warning is written when the cushion is nearly gone, and when it is shrinking steadily enough to run out
within the session, which is what a speaker whose clock runs ahead of the source's looks like. A stream can look
perfect on the server and still go choppy for good when that cushion drains, and nothing else in the log could see it.
