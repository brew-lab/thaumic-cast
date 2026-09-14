---
'@thaumic-cast/extension': patch
---

feat(extension): warn when the network path to a casting speaker is unstable

Audio to a Sonos speaker stuttered whenever the tablet's Wi-Fi had latency spikes, while the tablet's own playback was
fine, and nothing in the extension said what to do about it. The companion now judges the network path to each
playing speaker and, when a bigger jitter buffer would ride out the stalls it saw, says which value; the popup shows
a dismissible warning telling the user to raise the buffer to that value, with a shortcut to settings. When no buffer
would help it says so and suggests moving closer to the router or going wired. The extension only shows what the
companion decided. The jitter buffer setting, which is the remedy, was labelled like a codec detail; it is now
"Network buffer (jitter)" with a line explaining what each value buys and costs.
