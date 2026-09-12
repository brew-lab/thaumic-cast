---
'@thaumic-cast/core': patch
'@thaumic-cast/server': patch
---

fix(server): stop panicking at startup and serve audio on the streaming runtime

`thaumic-server` aborted immediately with "Cannot block the current thread from within a runtime" because the
streaming runtime blocked on a channel from inside `#[tokio::main]`. The runtime is now built on the calling thread
and handed to a keeper thread, so nothing blocks and it can be created from any context. The server also serves
HTTP on that runtime, as the desktop app does, so its priority-elevated workers carry the audio path instead of
sitting idle.
