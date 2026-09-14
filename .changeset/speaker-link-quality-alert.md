---
'@thaumic-cast/extension': patch
---

feat(extension): warn when the network path to a casting speaker is unstable

Audio to a Sonos speaker stuttered whenever the tablet's Wi-Fi had latency spikes, while the tablet's own playback was
fine, and nothing in the extension said so. The companion now reports the quality of the network path to each playing
speaker, and the popup shows a dismissible warning naming the speaker and the number of latency spikes in the last
minute, with a shortcut to settings. The jitter buffer setting, which is the remedy, was labelled like a codec detail;
it is now "Network buffer (jitter)" with a line explaining what each value buys and costs.
