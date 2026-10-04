---
'@thaumic-cast/extension': patch
'@thaumic-cast/protocol': patch
---

feat(extension): drive video sync from the companion's measurement of how late the speakers play

Video sync now plays the page's sound early by as much as the speakers play late, so a film's lips and words arrive
together. The amount is the companion's estimate of the delay for the cast's first speaker, plus the time the audio
spends in the extension before it leaves, less 40 ms, because sound a touch late is far less noticeable than sound
early. It moves in one step when the estimate moves by more than 40 ms (at most once every five seconds), and at once
when the estimate starts afresh or the fine-tune changes. If the measurement is lost, the sound stays where it is.
Stopping the cast puts the page's sound back first.

The old video sync, which paused and nudged the page's video, is gone: the video it moved carried the very sound
being cast, so it could never line up. The script it ran on every page is gone with it.

Each cast's card shows where video sync stands (locking on, in step, can't sync, or turned off, with the reason), a
fine-tune slider for the speaker being followed, kept per speaker, a Reload page button for pages opened before video
sync was on, and Try again after the player turned the early sound off. Video sync needs a PCM cast from a tab and a
companion new enough to send its estimate; otherwise the card says which is missing and nothing is moved. The
speaker's own output delay is not measured yet, so the fine-tune starts at zero and may need setting once per speaker.
