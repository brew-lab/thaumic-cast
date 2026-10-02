---
'@thaumic-cast/extension': patch
'@thaumic-cast/protocol': patch
'@thaumic-cast/core': patch
---

fix(extension): remove the HE-AAC options, which were AAC-LC under another name

The HE-AAC and HE-AAC v2 choices are gone from the custom quality settings. The browser encodes plain AAC-LC whatever
kind of AAC it is asked for (measured on Chrome and Edge on Windows, where all three choices gave exactly the same audio
at the same bitrate), so they never sounded or behaved differently from AAC-LC.

AAC-LC gains 96 and 160 kbps, so a low-bitrate option is still there. A bitrate the browser cannot encode on your
machine is not listed (256 kbps on Windows). Choosing AAC-LC in the custom settings starts at 192 kbps, its usual
bitrate, not at the lowest one.

The Economical preset now says what it sends: AAC-LC at 96 kbps, where on Windows it used to say HE-AAC v2 at 96 kbps
for the same audio. Where it used to pick 64 kbps it now uses 96 kbps.

A custom setting saved with HE-AAC or HE-AAC v2 becomes AAC-LC at the nearest bitrate (64 kbps becomes 96 kbps), and
the change is saved the first time the settings are read, without dropping the connection to the companion.

The companion still accepts both HE-AAC names from an extension that has not been updated. Its only change is that the
message for a codec it does not know no longer lists them.
