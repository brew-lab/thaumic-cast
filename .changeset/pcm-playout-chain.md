---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

feat(core): carry a PCM playout across segment connections

A PCM cast is now served in segments. Each connection's WAV header declares 4294901760 data bytes (6h12m49.28s at
48 kHz stereo, safely under the 4 GiB a Playbar obeys), and its body ends exactly there. One playout per stream and
speaker owns the cadence and outlives its connections, so segment `n + 1` (`/stream/{id}/live/{n+1}.wav`) starts at
the sample right after segment `n`'s last one, however long the speaker takes to fetch it. Between segments a park
pump keeps the cadence polled into a backlog, so nothing is lost while no connection is open, and it keeps polling
while the next connection drains that backlog. A parked playout is kept at least 60 s from the later of its last
connection closing and the speaker reporting STOPPED.

How a fetch continues the playout is decided before anything treats it as a new connection or a resume, so a
continuation waits for no prefill, starts no new epoch and sends no resume `Play`. The rules follow what Sonos
speakers were seen to do on S2 86.10:

- A fetch of the next segment while the current one is still being served (a Play:1 coordinator makes one as soon
  as the next item is queued) gets the header at once and audio only from the moment the current segment ends. If
  the speaker closes it before then, as it does after about 10 s, it has taken nothing.
- A second plain fetch of the segment being served (a Playbar makes one right after it switches) gets just the
  header and never disturbs the connection the speaker plays from. A range past the segment's end gets `416`.
- A speaker resuming after a pause fetches its segment again with `Range: bytes=X-`. It is answered `206` with
  exactly the rest of that segment from the live edge, so the segment still ends at its declared size and the next
  one stays aligned.
- A segment is replayed from its first byte only when the speaker provably played none of it. Pressing Next in the
  Sonos app starts the next segment at the first byte not yet sent, and a segment fetched again after it ended
  carries on with new audio, never repeating any.

The speaker monitor, the connection summaries and the pipeline timeline now report on the playout. Delivered audio
runs on across segments with every header excluded, acknowledgement lag is read from whichever connection is being
served, each connection's summary covers only its own share, and the monitor maps a later segment's URL and RelTime
onto the playout's, so a segment switch is neither a track change nor RelTime going backwards. The 15 s after each
boundary are treated like a declared end: no stall and no notice.

Nothing moves a speaker on to the next segment yet, so a cast still ends after the first (now 64 KiB short of 4 GiB).
Restarting at the boundary and queueing the next segment for a gapless handover follow. The new test switch
`THAUMIC_PCM_SEGMENT_BYTES` shortens segments (1048576 up to the default, rounded down to whole 10 ms frames;
`10485760` gives 54.61 s at 48 kHz stereo). It is ignored while a switch that fixes a connection's end is set, and
those serve PCM on one connection as before.
