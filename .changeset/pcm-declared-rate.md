---
'@thaumic-cast/extension': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

fix(extension,core): a PCM cast declares the rate it was captured at

A PCM cast now tells the companion the sample rate Chrome really captured the tab at. It used to be able to state a
rate left over in the settings from another codec, and since PCM is not resampled the cast then played at the wrong
speed. If Chrome captures at a rate that cannot be sent, the cast does not start and the popup says which rate it was
and to choose another codec under Settings. The other codecs are unchanged.

The companion now refuses a cast that declares a sample rate of zero, or one it cannot serve, with a message naming
the rate; a rate of zero used to crash that connection. Its log line for a new stream also records the bitrate, the
connection and the address it came from, and it logs when an older client uses the `codec` or `speakerIp` fields.
