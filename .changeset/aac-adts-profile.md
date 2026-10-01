---
'@thaumic-cast/extension': patch
---

fix(extension): label AAC streams as AAC-LC, not AAC Main

Every AAC frame the extension sends carries a small header that tells the speaker what kind of AAC follows. That
header named the wrong kind: AAC-LC audio was labelled AAC Main, and the HE-AAC variants were labelled as a kind they
are not. A speaker that believes the label can refuse the stream or decode it wrongly. AAC-LC is now labelled AAC-LC.
HE-AAC and HE-AAC v2 are labelled the way the format requires, as their AAC-LC core at half the sample rate (and mono
for v2), which a decoder that knows them extends on its own; that part follows the specification and has not yet been
checked against a speaker.
