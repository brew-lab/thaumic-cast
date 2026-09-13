---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
---

fix(core): stop speakers when browser capture ends, and match the capture format

Ending a browser-audio cast dropped the stream without telling the speakers, so they kept playing, grouped members
stayed joined, and no stopped event was sent. The same teardown the socket-close path uses now runs first. Browser
capture also built the stream from the encoder settings the extension sent, while the audio came from the capture
device, so a non-default audio mode produced a stream header that did not describe the audio. The codec is now always
PCM and the sample rate and channel count come from the format the capture device negotiated.
