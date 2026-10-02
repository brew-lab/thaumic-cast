---
'@thaumic-cast/extension': patch
---

feat(extension): show the fall-behind setting for PCM and reset a stale hidden value once

"Latency Mode" is now "When the connection falls behind", and its two choices say what they do: "Let delay grow (up to
a limit)" and "Skip ahead (brief gaps)". The setting used to be shown only for AAC and FLAC, but a Bespoke PCM cast
obeyed it too, so anyone who had picked the second choice for AAC and then moved to PCM was skipping audio with no
control on the page to say so. It now appears under Advanced for Bespoke PCM. Because nobody could have chosen it for
PCM before, a stored "Skip ahead" on Bespoke PCM is set back to "Let delay grow" once, when this version first loads
the settings. After that the choice is yours and is kept. The presets and every other setting are unchanged.
