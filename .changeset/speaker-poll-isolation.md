---
'@thaumic-cast/core': patch
---

refactor(core): poll speakers in isolated tasks with quiet SOAP

The latency monitor polled every speaker's position in turn from one loop and waited on each answer, so a speaker
that stopped responding held up every other speaker's polls, and the video-sync measurements with them, for up to the
full ten-second SOAP timeout per attempt. Each poll now runs in its own task and is abandoned after 1.5 s; a speaker is
never polled again while its previous poll is outstanding, and after three failed polls in a row it is asked only every
five seconds until it answers. Position polls also log their per-call SOAP lines at debug instead of info, so a long
cast no longer fills the log with them. What is measured and when a speaker is polled are otherwise unchanged.
