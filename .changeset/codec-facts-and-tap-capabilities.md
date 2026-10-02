---
'@thaumic-cast/core': patch
---

refactor(core): one table of per-codec facts, and named capabilities on the connection tap

An internal restructuring with no behaviour change and no log change. What the server decides from a stream's codec
was spread over a dozen `match` and `==` sites in six files. It is now one table, `AudioCodec::facts()`, with one named
fact per reason: the name, the MIME type, the cleanup order, the form of the speaker URI, ICY support, the container
header bytes, whether the codec takes the PCM serving path, whether its ring is raised to the PCM floor, and whether
24-bit is accepted. Each site reads the fact named for its reason, and a test pins every fact for PCM, AAC, MP3 and
FLAC to the value the old code held. `AudioCodec` and `CleanupOrder` now live in `stream/codec.rs`; every existing
import path still resolves, and no log line moved, so the module paths the log prints are unchanged.

The speaker monitor and the tap asked "is the byte rate non-zero" in four places to mean two things. Those are now
`ConnectionTap::measurable()` (delivered bytes convert to playback time) and `steerable()` (the reserve can be
steered), each defined as the check it replaces. The byte rate remains the field used for arithmetic.
