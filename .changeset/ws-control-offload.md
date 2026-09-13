---
'@thaumic-cast/core': patch
---

fix(core): keep speaker commands from interrupting audio

Volume, mute, query and playback commands were handled in the same place incoming audio is read, so a slow or
unreachable speaker stalled the stream for as long as its requests took, well beyond the buffer. Commands now run on a
separate worker per connection with replies passed back in order, leaving audio to flow while they complete.
