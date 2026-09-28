---
'@thaumic-cast/protocol': patch
'@thaumic-cast/core': patch
---

feat(protocol): describe speaker notices and the companion's audio settings

The protocol now describes what the companion decided to tell a user about a speaker: the speakerHealth event
carries an optional `notice` (its kind, `noticeId`, the stall, what was left, the head start sent and suggested, the
minutes to running low, and whether a restart refills the speaker), beside the head start sent and configured, the
floor, the stall and the time to the floor. A notice this build cannot read is dropped rather than failing the whole
report. Two stream events are added: `ingestGaps`, when audio from the browser reached the companion late often enough
to give every speaker a gap, with the smoothing step that would have covered it, and `companionAudioChanged`, with the
speaker head start (0 to 2000 ms), whether an environment variable fixes it, and whether the speaker monitor is on.
The companion also sends those settings in `INITIAL_STATE` as `companionAudio`, so a client can show the head start
and word its notices from the moment it connects; an older companion leaves it out, and malformed settings degrade to
absent instead of failing the snapshot.
