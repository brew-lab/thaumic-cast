---
'@thaumic-cast/server': patch
---

fix(server): exit with an error when the HTTP server cannot start

A failed port bind was only logged inside the spawned task. The process then reported that the server had started and
waited on the shutdown signal forever, so a service manager saw a healthy unit and never restarted it. Startup now
fails properly and the process exits with a non-zero status.
