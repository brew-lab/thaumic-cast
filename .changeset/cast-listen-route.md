---
'@thaumic-cast/core': patch
---

feat(core): add a listen route for players on this computer

A cast can now be heard at `/stream/{id}/listen` (also `listen.wav` and `listen.flac`) by a player such as VLC or a browser. Each player gets its own connection from the live edge and is never treated as a speaker, so any number can listen at once, and seeking or reconnecting in one does not silence another or touch a speaker. Before, two players on this computer opening a PCM cast's `live.wav` starved each other, and a seek in one silenced it. A PCM cast is served as an endless WAV and a seek starts again from the live edge. Other devices on the network follow the same rules as any reader the cast is not playing on: refused when strict stream access is on, otherwise allowed up to the usual limit. The existing stream URLs behave exactly as before.
