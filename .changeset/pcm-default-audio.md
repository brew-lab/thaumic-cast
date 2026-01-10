---
'@thaumic-cast/extension': patch
---

Default custom audio settings to PCM codec instead of AAC-LC

PCM is always available as raw audio passthrough with no WebCodecs dependency, ensuring the default settings always work regardless of browser/system codec support.
