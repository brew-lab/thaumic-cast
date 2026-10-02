---
'@thaumic-cast/extension': patch
---

fix(extension): a mono PCM cast carries both channels

A mono PCM cast now carries both channels mixed together; it used to carry the left one only, so anything that was
only in the right channel went missing. Stereo casts are unchanged.

The log now records, once per PCM cast, the sample rate the capture delivers beside the rate the cast declared, and
warns when the two differ.
