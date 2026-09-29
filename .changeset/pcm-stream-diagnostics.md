---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

fix(core): log how each speaker fetch is framed and why it ended

A speaker's fetch was logged as "ended normally" whether the speaker hung up, hyper stopped at the declared
`Content-Length`, or the cast was stopped, so a PCM cast that stopped after hours could not be explained from the log.
The `[Stream] New connection` line now gives the request's HTTP version (`http=`), how the body is delimited
(`framing=length|chunked|close`) and the length it declares (`declared_len=`), and a Range request gets the same line at
info level with its range instead of a debug line. Both `HTTP stream ended` lines now give the payload handed over
(`bytes_sent=`), the bytes that put on the wire including chunk framing (`wire_bytes=`), and who ended it (`ended_by=`):
`client` when the speaker went away, `length` when hyper wrote the whole declared length, `server_shutdown` when the
stream ended on our side, `error` when the body failed, and `server_cap` for a test cap that a later field experiment
adds. These are diagnostics for field experiments; what is served is unchanged, and PCM still declares a 4294967295-byte
`Content-Length`. The speaker monitor's acknowledged-bytes lag is now counted against the bytes on the wire, which only
differs on a chunked body (the compressed codecs today): counted against the payload, the chunk framing let the
acknowledged count overtake it within minutes and the lag read zero.
