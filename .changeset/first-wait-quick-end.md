---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

fix(core): stop blaming the first-connection wait when a speaker rejects the stream at once

When a speaker's first connection ended within 100 ms of its first bytes, the log still said the first-connection wait
was not survived and suggested a shorter speaker head start. A speaker that hangs up that soon has already sat through
the wait, so the warning now says the speaker ended the connection right after the stream started, which can mean it
rejected the stream (for example an invalid WAV header), unless the cast was stopped. An end later than that keeps the
wait-specific warning.
