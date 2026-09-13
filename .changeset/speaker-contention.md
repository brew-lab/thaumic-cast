---
'@thaumic-cast/core': patch
---

fix(core): make two clients choosing one speaker safe

Sessions are indexed by speaker as well as by stream, and only one entry per speaker is kept in that index, so two
clients starting on the same speaker at once left an entry that lookups by speaker could never find and cleanup never
reached. Starting playback now takes a lock for that speaker, covering the grouped path as well, so the sequences
cannot interleave. The later client still takes the speaker; only the leftover state was wrong.
