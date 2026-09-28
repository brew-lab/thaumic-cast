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
the rest exactly as before, with the full jitter buffer still queued on the server. A connection moments after the
stream starts bursts only what the stream holds beyond the jitter buffer, and never pads with silence. End-to-end
latency grows by the burst; the playback epoch is anchored to the first burst frame, so video sync and the speaker
monitor's reserve account for it. A PCM stream's ring now holds the largest burst plus the largest jitter buffer, which
also fixes jitter buffers above 500 ms being silently capped at 500 ms. Compressed codecs are unaffected. The burst is
set with `pcm_connect_burst_ms` in the server's config.yaml or `THAUMIC_PCM_CONNECT_BURST_MS` (0 turns it off, at most
2000), and applies from each speaker's next connection.
