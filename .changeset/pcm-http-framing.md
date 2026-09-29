---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

feat(core): add test switches for how a PCM stream is framed over HTTP

A PCM cast to a Playbar stopped after exactly 2^31 bytes, and the speaker may be obeying the declared `Content-Length`,
the size fields in the WAV header, or a counter of its own. Four environment variables, read again for each speaker
connection, let a field experiment change one of these at a time without a rebuild. `THAUMIC_PCM_HTTP_FRAMING` picks
`length`, `chunked` (no length) or `close` (an HTTP/1.0 response with `Connection: close`, ended only by closing the
connection). `THAUMIC_PCM_CONTENT_LENGTH` sets the length declared with `length` framing. `THAUMIC_PCM_WAV_DATA_SIZE`
sets the WAV header's data size (0 to 4294967295), with the RIFF size to match. `THAUMIC_PCM_END_AFTER_BYTES` ends each
body cleanly from our side after that many bytes, logged as `ended_by=server_cap`; it is refused with `length` framing,
where ending early would abort the connection. A connection served with any of them set logs a `[Stream] PCM HTTP
switches` line, and an invalid value (including one that is not valid UTF-8), or one that does not apply to the chosen
framing, is ignored with a warning. These switches are for field experiments only; the WAV header keeps 0xFFFFFFFF in
both size fields (a 4 GiB length, not an unbounded marker) unless one says otherwise, and every stream response keeps its headers in the same order as before. The
experiments found the 3h06m stop, and PCM is now chunked by default (see the change that serves PCM chunked). The
speaker monitor's acknowledged-bytes lag already counts chunk framing, so it stays right on a chunked PCM connection.
