---
'@thaumic-cast/core': patch
---

refactor(core): name the phases of the stream handler

An internal restructuring with no behaviour change. The function that answers a speaker's fetch of a stream was about
600 lines long. Eight of its phases are now functions of their own in the same file: admission, framing and the fetch
log, segment routing, guard construction, playout statistics, the tap and epoch hook, the body pipeline and response
assembly. Each is the same statements as before, run at the same point.

The part that decides between a resume and a first connection, waits before the first response and subscribes to the
stream is left where it was, untouched. Nothing is awaited anywhere else, every log line is the same and is written in
the same order, and the module path the log lines print is unchanged.
