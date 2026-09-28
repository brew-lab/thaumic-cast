---
'@thaumic-cast/extension': patch
---

feat(extension): warn when a casting speaker's buffer runs low

A speaker that plays slightly faster than the audio arrives drains its buffer over an hour or two and then stutters,
with nothing on the casting machine looking wrong. The extension now keeps the companion's latest speakerHealth
reading for each speaker it is casting to, logs it, and shows a dismissible "speaker buffer running low" warning in
the popup, beside the link-quality warning, while the speaker is low or draining; when draining it says roughly how
many minutes are left. A dismissed warning stays dismissed through the repeats every 30 s and returns only after the
speaker recovers and runs low again. Readings are dropped when the speaker leaves the cast or the connection drops.
