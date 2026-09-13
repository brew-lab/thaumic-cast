---
'@thaumic-cast/protocol': minor
'@thaumic-cast/core': patch
'@thaumic-cast/extension': patch
---

feat(protocol): say when another client takes a speaker, and show speakers in use

Taking a speaker from another client sent a stop with no reason, so the other person saw a generic message. A distinct
reason is now sent and shown. The extension also never read the session list the server provides, so availability came
only from that browser's own casts and the automatic choice was always the first group alphabetically, meaning several
machines defaulted to the same speaker and each showed it as free. Speakers in use by another client are now a
separate state, skipped when choosing automatically and still selectable deliberately, and the concurrent stream count
comes from the server rather than one browser's view.
