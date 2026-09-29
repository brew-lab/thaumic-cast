---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

feat(core): queue the next PCM segment for a gapless handoff

A PCM cast now moves from one segment to the next with no audible switch. Ten seconds after the coordinator reports
PLAYING on a segment, the server queues the next one as its next item (`SetNextAVTransportURI`, with the same
broadcast DIDL-Lite the cast starts with). A Sonos speaker fetches it the moment the current segment's body ends, plays
out what it holds and switches with no STOPPED: in a hardware probe on S2 86.10 a Playbar switched about 1.2 s after the
server's end and a Play:1 group about 3.8 s after, three boundaries out of three each, and the switch could not be
heard. The playout carries on sample for sample, so nothing is skipped or repeated.

- **Never two ahead.** Only the segment after the one the speaker reports playing is queued, never the one after that
  while the next is still pending (the probe skipped a segment doing that during a pause). A queue that an event shows
  cleared, by a `SetAVTransportURI` or a resume, is queued again; the new `NextAVTransportURI` field of the GENA
  transport event says what is queued. Nothing is queued while paused, during a switch, or with less than 15 s of the
  segment left (a Play:1 fetches a queued item at once and holds that fetch about 10 s; it is served just the header
  and takes no audio).
- **Restart as the fallback.** A speaker that stops on the old segment although the next was queued is restarted exactly
  as before, with every guard: a STOPPED that lasted a second and is confirmed by asking, never while the speaker still
  plays or is paused, and not at all once it fetched the next segment itself. `Continuation fallback` is logged with
  `reason=stopped_on_previous` or `no_fetch`, and the speaker (by UUID) is restarted at every later boundary until the
  server restarts, without queueing. A speaker that refuses the queued item twice is treated the same way
  (`reason=soap_error(…)`).
- **The switch stays invisible.** From 2 s before a segment's end until the speaker plays the next one, its transport
  state and that of every speaker joined to it are held from clients, as for a restart. A handoff now ends only on
  PLAYING on the segment the speaker fetched, not on a late PLAYING on the old one while it plays out what it holds.

`THAUMIC_PCM_CONTINUATION` takes `auto` (the new default: queue, and restart a speaker that does not follow), `next`
(queue every time, still restarting a boundary that is missed), `restart` (never queue) or `off`. The plan was to keep
`restart` as the default until a field test proved the queued handover; the probe already did on a Playbar and on a
Play:1 group, so `auto` is the default now rather than in a later change. `THAUMIC_PCM_SEGMENT_DIDL=track` describes a
queued segment as an `object.item.audioItem.musicTrack` with its duration and size, for comparison only: a Playbar then
fetches it early and past its end, and Sonos ignores the duration anyway. Each boundary logs `Continuation armed`,
`Continuation fetch`, `Continuation joined` and `Continuation playing` with `mode=next` and `stops_seen`, the number of
STOPPED events the switch showed (0 when gapless).
`audible_gap_ms` in `Continuation playing` is 0 for a switch with no STOPPED and no restart, however long the speaker
took to report PLAYING on the next segment (a group's coordinator takes about 3.8 s while it plays out what it holds);
it is measured only from a STOPPED, or for a restart without one, from when the speaker's reserve should have run out.

With a segment queued, the Sonos app may show a next item and enable its skip button. A skip there jumps the cast to the
live edge, as any skip does, and the segment after is queued as usual.
