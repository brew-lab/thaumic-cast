---
'@thaumic-cast/extension': patch
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

fix(extension,core): a PCM cast declares the rate it was captured at

A PCM cast now tells the companion the sample rate Chrome really captured the tab at. It used to be able to state a
rate left over in the settings from another codec, and since PCM is not resampled the cast then played at the wrong
speed. The extension waits up to 300 ms for the tab's first audio and declares the rate of that. If Chrome captures at
a rate that cannot be sent, the cast does not start and the popup says which rate it was and how to choose another
codec under Settings. The other codecs are unchanged.

A tab that is silent or paused may deliver no audio in that time, and a cast from one still starts as before: it
declares the rate Chrome reports for the tab, or 48 kHz if that is not a rate it can send, and never the rate in the
settings. If the audio then arrives at a different rate, the cast stops and the popup gives both rates and says to
cast again while the tab is playing, or to choose another codec when the rate is one PCM cannot be sent at. A cast
whose capture changes rate partway through now stops with the same message; it used to stop without one.

The companion now refuses a cast that declares a sample rate of zero, or one it cannot serve, with a message naming
the rate; a rate of zero used to crash that connection. Its log line for a new stream also records the bitrate, the
connection, the address it came from and the client id, and it logs when an older client uses the `codec` or
`speakerIp` fields, saying which connection it was.
