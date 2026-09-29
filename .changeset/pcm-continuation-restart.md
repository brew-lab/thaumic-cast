---
'@thaumic-cast/core': patch
'@thaumic-cast/protocol': patch
'@thaumic-cast/extension': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

feat(core): restart a PCM cast at the segment boundary

A PCM cast no longer ends after its first segment (6h12m49s at 48 kHz stereo). A Sonos speaker plays a segment to the
length its WAV header declares, plays out what it holds and reports STOPPED, about 1.2 s after the server's end on
S2 86.10, without fetching anything more. Once it has stayed STOPPED on that segment for a second, and asking it
(`GetTransportInfo`, `GetPositionInfo`) confirms it, the server tells it to play the next segment itself, which carries
on the playout from where the last one ended: a short pause, with nothing for the user to do. The expected gap is the
1 s confirmation, two SOAP polls, `SetAVTransportURI` and `Play`, and the speaker's start-up, probably 2-3 s once
its reserve has run out; the field test will set the figure.

- **Never early, never twice.** `SetAVTransportURI` throws away whatever the speaker still holds, so nothing is sent
  while the speaker is still playing or paused, or after a STOPPED that does not last. With no word from GENA the
  speaker is asked once its reserve should have played out, and again every 500 ms while it says PLAYING; a STOPPED
  found that way must also last a second and be confirmed again, and a speaker stopped with no media at all is left
  to end the cast as before. The restart
  goes out under the speaker's start lock, and not at all if the speaker fetched the next segment itself meanwhile or
  a new playout took over.
- **No false alarms.** From 2 s before a segment's end until the speaker plays the next one, a STOPPED or
  TRANSITIONING from the coordinator or any speaker joined to it is recorded as usual but neither broadcast nor shown in
  snapshots (the desktop app's transport view included), so the extension (current builds included) never takes the
  switch for the speaker giving up. Once the coordinator plays the next segment it is released; each joined speaker
  stays held until it reports PLAYING or PAUSED itself, or for 5 s at most, since a joined speaker's own events can
  lag the coordinator's by seconds and the STOPPED it recorded at the segment's end is not news. A pause or a
  skip in that window ends the hold, and the Sonos TV input or another app taking a speaker over still ends the cast.
- **No lasting latency.** The audio produced while the speaker stopped and restarted is not all sent: unless drift
  correction is steering the speaker, it rejoins with just its head start, the oldest audio dropped inside the pause
  and the rest faded in, so latency does not grow by the length of the pause every segment. With drift correction on, up
  to 2 s is kept sample for sample and paid back, and `Continuation debt repaid` is logged when it has been.
- **A gentle end if it cannot continue.** A speaker that does not play the next segment within 10 s is told once more;
  after that the cast ends on it with the new stop reason `continuation_failed`, which the extension shows as a gentle
  "cast again to carry on" message instead of the speaker having wandered off. Older extensions show their generic
  stop message.

The test switch `THAUMIC_PCM_CONTINUATION` (`restart`, the default, or `off`, where a cast ends after its first
segment as before) is reported on the `[Stream] PCM HTTP switches` line. Each boundary logs `Handoff`, `Continuation
restart` (with its trigger and rejoin policy), `Continuation joined` (with `dropped_ms` and `latency_debt_ms`) and
`Continuation playing` (with the audible gap). The handoff's watch runs on the main runtime, keeping its SOAP calls
off the streaming runtime.
