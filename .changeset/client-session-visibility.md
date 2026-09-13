---
'@thaumic-cast/core': patch
---

feat(core): scope session details and speaker commands to the extension

The state sent when a client connects listed every active session in full, including identifiers belonging to other
connections. Sessions owned by another connection are now reduced to the speaker plus an opaque placeholder, which is
enough for a client to show that a speaker is in use, and events that name or quote an identifier are filtered or
rewritten per connection. Connections are attributed by peer address so ownership is recorded consistently.

The socket upgrade now also requires a browser extension origin, so an ordinary web page cannot open it, and the
observed origin is logged. Browser capture, which records audio on the machine running the server, is restricted to
that machine.
