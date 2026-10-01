---
'@thaumic-cast/extension': patch
---

fix(extension): label AAC streams as AAC-LC, not AAC Main

Every AAC frame the extension sends carries a small header that tells the speaker what kind of AAC follows. That
header named the wrong kind: AAC-LC audio was labelled AAC Main, and the HE-AAC options were labelled AAC-LTP. All AAC
options are now labelled AAC-LC at the stream's own sample rate and channels, because that is what the browser encodes
for every one of them: measured on Chrome and Edge on Windows, the HE-AAC and HE-AAC v2 options produce exactly the
same audio as AAC-LC at the same bitrate. How the speakers treated the old labels has not been measured.
