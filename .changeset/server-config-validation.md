---
'@thaumic-cast/core': patch
'@thaumic-cast/server': patch
---

fix(server): validate configuration instead of failing later

A topology refresh interval of zero was accepted and then panicked inside a background task, aborting the release
binary and leaving a service manager to restart it repeatedly with an unhelpful message. Configuration is now checked
at load with a clear error, the monitor clamps the interval defensively, and environment variables are read in one
place so an invalid value is reported rather than ignored.
