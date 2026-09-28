---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

feat(core): send each speaker a burst of audio when it starts fetching a PCM stream

A PCM (WAV) stream was paced at real time from its very first frame, so a speaker never held more than a few tens of
milliseconds of audio ahead of its playhead, and a Wi-Fi loss burst longer than that was heard as a stutter. Raising
the network buffer only deepened the server's own queue. When a speaker's fetch starts, including a reconnect or
resume, the server now sends it up to 500 ms of already-captured audio as fast as the connection takes it, then paces
the rest exactly as before, with the full jitter buffer still queued on the server. A speaker's first connection
waits, before the response starts, until the stream holds the burst as well as the jitter buffer (700 ms at the
defaults, counted from the stream's first frame), so a fresh cast gets the whole burst. That wait is not capped, so a
large burst adds as much to it; it is logged, and so is whether the speaker kept its connection through it, which shows
whether a speaker accepts a long one. A resume is never delayed and
bursts only what the stream holds beyond the jitter buffer, never padding with silence. End-to-end
latency grows by the burst; the playback epoch is anchored to the first burst frame, so video sync and the speaker
monitor's reserve account for it. A PCM stream's ring now holds the largest burst plus the largest jitter buffer, which
also fixes jitter buffers above 500 ms being silently capped at 500 ms. Compressed codecs are unaffected. The burst, called
the speaker head start in the apps, is set in the desktop app under Settings > Speakers (Off, or 250 to 2000 ms), with
`pcm_connect_burst_ms` in the server's config.yaml, or with `THAUMIC_PCM_CONNECT_BURST_MS`, which outranks both (0
turns it off, at most 2000). It applies from each speaker's next connection, to PCM casts only.
