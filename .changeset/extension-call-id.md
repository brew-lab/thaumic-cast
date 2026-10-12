---
'@thaumic-cast/extension': patch
---

fix(extension): match playback results to the call that asked

Each request to start playback on a cast's stream now carries its own id (the stream's id and a count), and a
reply that echoes another id is ignored. Before, a reply that arrived after its request had timed out could be taken
for the answer to a Try again on the same room. An older companion echoes no id, and its replies are still matched
by the speakers they name.
