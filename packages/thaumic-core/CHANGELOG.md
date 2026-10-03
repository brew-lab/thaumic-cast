# @thaumic-cast/core

## 0.11.1

### Patch Changes

- [#223](https://github.com/brew-lab/thaumic-cast/pull/223) [`50189e1`](https://github.com/brew-lab/thaumic-cast/commit/50189e138395160a1700e2b6856d133b5ed0019a) Thanks [@skezo](https://github.com/skezo)! - fix(core): say why a 24-bit request falls back to 16-bit

  When a client asks for 24-bit audio in a codec other than FLAC, the stream is made 16-bit and a warning is logged.
  The warning read `24-bit audio requested but codec is Pcm, falling back to 16-bit`, which suggested the codec was the
  wrong one for the request rather than saying what the limit is. It now reads
  `[WS] 24-bit audio requested with codec Pcm, but only FLAC carries 24-bit; streaming 16-bit`. Anyone grepping for the
  old text should look for `only FLAC carries 24-bit`. What is streamed does not change.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`602c9ee`](https://github.com/brew-lab/thaumic-cast/commit/602c9ee2ff71b41f4added085bda4a48c1d1154c) Thanks [@skezo](https://github.com/skezo)! - fix(core): resynchronise a client that falls behind

  Only successful reads from the event channel were handled, so a client that stalled lost events silently and its view
  of speakers, volumes and sessions drifted until it reconnected. A closed channel did not end the connection either.
  Falling behind now logs and re-sends the state snapshot, and a closed channel ends the loop.

- [#207](https://github.com/brew-lab/thaumic-cast/pull/207) [`44b237d`](https://github.com/brew-lab/thaumic-cast/commit/44b237db820faf85e1bf5eaea043888888e64386) Thanks [@skezo](https://github.com/skezo)! - fix(extension,core): disable capture, keep-awake and video sync controls where they cannot act

  The companion now says whether it can capture the whole browser for the extension asking, and the Settings page uses
  the answer. Against a server, or a desktop app on another machine, Browser-wide capture can no longer be turned on and
  says why. If it is already on, it stays visible and can always be unticked, with a line saying a cast will not start
  until it is. It is hidden only when it is off and the companion is a server. With no companion connected, or one too
  old to say, the control is as it was.

  Keep the tab awake is disabled under browser-wide capture, where it does nothing, and says so; the choice is kept.

  Video sync controls appear in the popup only on a cast that was started with Video sync turned on. Turning
  the setting on during a cast used to show controls that never locked; the setting now says a change applies from the
  next cast.

  Choosing "Enter the address" for the companion without a saved address now shows a line saying no address is saved and
  that the extension is still looking on this machine, instead of nothing.

  No stored setting or default has changed.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`d8ff2b9`](https://github.com/brew-lab/thaumic-cast/commit/d8ff2b951513c2d16b0078bce7bf51b54ba6f688) Thanks [@skezo](https://github.com/skezo)! - feat(core): measure what captured audio contains and allow tapping it to disk

  Every captured packet is now inspected and a summary is logged every five seconds: peak, level, packets with holes of
  silence inside audio, packets identical to the one before, silent packets and clipping, with a warning when the audio
  has holes in it. Timing counters cannot see this; a source that starves still delivers the right number of samples on
  time. Setting `THAUMIC_CAPTURE_TAP_DIR` writes everything pushed into the pipeline to a WAV file per stream so a failed
  session can be listened to afterwards, and setting `THAUMIC_NO_PRIORITY_BOOST` leaves the process and its audio threads
  at default scheduling, to test whether the boost is starving the browser being captured on a small machine.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`921110c`](https://github.com/brew-lab/thaumic-cast/commit/921110c2c05b2d2af9689de4d10279848e4d538d) Thanks [@skezo](https://github.com/skezo)! - fix(core): stop speakers when browser capture ends, and match the capture format

  Ending a browser-audio cast dropped the stream without telling the speakers, so they kept playing, grouped members
  stayed joined, and no stopped event was sent. The same teardown the socket-close path uses now runs first. Browser
  capture also built the stream from the encoder settings the extension sent, while the audio came from the capture
  device, so a non-default audio mode produced a stream header that did not describe the audio. The codec is now always
  PCM and the sample rate and channel count come from the format the capture device negotiated.

- [#227](https://github.com/brew-lab/thaumic-cast/pull/227) [`bba9149`](https://github.com/brew-lab/thaumic-cast/commit/bba91491e1ae1d40b7950a31b66ab9b3f4c74ce9) Thanks [@skezo](https://github.com/skezo)! - feat(core): add a listen route for players on this computer

  A cast can now be heard at `/stream/{id}/listen` (also `listen.wav` and `listen.flac`) by a player such as VLC or a browser. Each player gets its own connection from the live edge and is never treated as a speaker, so any number can listen at once, and seeking or reconnecting in one does not silence another or touch a speaker. Before, two players on this computer opening a PCM cast's `live.wav` starved each other, and a seek in one silenced it. A PCM cast is served as an endless WAV and a seek starts again from the live edge. Other devices on the network follow the same rules as any reader the cast is not playing on: refused when strict stream access is on, otherwise allowed up to the usual limit. The existing stream URLs behave exactly as before.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`602c9ee`](https://github.com/brew-lab/thaumic-cast/commit/602c9ee2ff71b41f4added085bda4a48c1d1154c) Thanks [@skezo](https://github.com/skezo)! - feat(core): scope session details and speaker commands to the extension

  The state sent when a client connects listed every active session in full, including identifiers belonging to other
  connections. Sessions owned by another connection are now reduced to the speaker plus an opaque placeholder, which is
  enough for a client to show that a speaker is in use, and events that name or quote an identifier are filtered or
  rewritten per connection. Connections are attributed by peer address so ownership is recorded consistently.

  The socket upgrade now also requires a browser extension origin, so an ordinary web page cannot open it, and the
  observed origin is logged. Browser capture, which records audio on the machine running the server, is restricted to
  that machine.

- [#221](https://github.com/brew-lab/thaumic-cast/pull/221) [`81ec293`](https://github.com/brew-lab/thaumic-cast/commit/81ec29349da70fec34767871561108d042a35614) Thanks [@skezo](https://github.com/skezo)! - refactor(core): one table of per-codec facts, and named capabilities on the connection tap

  An internal restructuring with no behaviour change and no log change. What the server decides from a stream's codec
  was spread over a dozen `match` and `==` sites in six files. It is now one table, `AudioCodec::facts()`, with one named
  fact per reason: the name, the MIME type, the cleanup order, the form of the speaker URI, ICY support, the container
  header bytes, whether the codec takes the PCM serving path, whether its ring is raised to the PCM floor, and whether
  24-bit is accepted. Each site reads the fact named for its reason, and a test pins every fact for PCM, AAC, MP3 and
  FLAC to the value the old code held. `AudioCodec` and `CleanupOrder` now live in `stream/codec.rs`; every existing
  import path still resolves, and no log line moved, so the module paths the log prints are unchanged.

  The speaker monitor and the tap asked "is the byte rate non-zero" in four places to mean two things. Those are now
  `ConnectionTap::measurable()` (delivered bytes convert to playback time) and `steerable()` (the reserve can be
  steered), each defined as the check it replaces. The byte rate remains the field used for arithmetic.

- [#187](https://github.com/brew-lab/thaumic-cast/pull/187) [`6c23a59`](https://github.com/brew-lab/thaumic-cast/commit/6c23a59c31b7ea8c177f59c43670960c1b6d3a10) Thanks [@skezo](https://github.com/skezo)! - fix(core): never send a resume Play to a player on the companion's own machine

  A local player such as VLC on the desktop machine reconnecting counted as a speaker resuming, so the server sent a
  Sonos SOAP Play to the computer's own address and logged `[Resume] Play command on HTTP resume failed`. Its reconnect
  is still a resume (the prefill wait is skipped and it keeps its own epoch), but only a speaker the stream is playing on
  is now sent Play.

- [#210](https://github.com/brew-lab/thaumic-cast/pull/210) [`c1a1b2d`](https://github.com/brew-lab/thaumic-cast/commit/c1a1b2dae603e3d92d0954ae336a8568fdcba508) Thanks [@skezo](https://github.com/skezo)! - feat(core): read the three speaker settings once at start-up, and say where each came from

  **Behaviour change.** Speaker monitoring, the speaker head start and clock drift correction are now settled once, when
  the app starts. Before, `THAUMIC_SPEAKER_MONITOR`, `THAUMIC_PCM_CONNECT_BURST_MS` and `THAUMIC_DRIFT_COMPENSATION` were
  read again each time a speaker connected, and there they beat both the flag and the file.
  - **Server:** a flag now beats an environment variable, which beats `config.yaml`, which beats the default, for these
    three settings as for every other. If you set both a flag and its variable, the flag is what you get.
  - **Desktop app:** an environment variable still beats the setting saved in Settings > Speakers, and the control still
    shows the variable's value and stays locked. A setting you change in the app applies from each speaker's next
    connection, as before.
  - **Both:** restart to apply a changed variable. Changing one while the app runs no longer does anything.
  - The log says, once at start-up, what each of the three is and where it came from, for example
    `pcm_connect_burst_ms = 500 ms (default)` or `speaker_monitor = off (--speaker-monitor)`.
  - `THAUMIC_SPEAKER_DIAGNOSTICS` still works, and still turns speaker monitoring on over everything else, an explicit
    off included. It now warns at start-up that `THAUMIC_SPEAKER_MONITOR=on` replaces it, and the desktop checkbox shows
    ticked and locked while it is set, where it used to show unticked.

  No setting, flag or variable is renamed, and no default changes.

- [#193](https://github.com/brew-lab/thaumic-cast/pull/193) [`644a955`](https://github.com/brew-lab/thaumic-cast/commit/644a955100483f155176286cf74fa0bb2627a400) Thanks [@skezo](https://github.com/skezo)! - fix(core): stop reporting a compressed cast's speaker as still locking

  A speaker's buffer can only be measured on a PCM stream. For AAC and FLAC the companion nevertheless reported the speaker
  as "locking" (still measuring) for the whole cast, as if a reading were on its way. It now reports "unmeasured" for those
  streams, in its log and to the extension and desktop app, and still says when such a speaker is paused, not answering or
  playing something else. PCM casts are reported exactly as before.

- [#187](https://github.com/brew-lab/thaumic-cast/pull/187) [`c43fad6`](https://github.com/brew-lab/thaumic-cast/commit/c43fad67014504b3cb9854c5bbd2d87a9066ded2) Thanks [@skezo](https://github.com/skezo)! - fix(core): keep drift correction steady across a PCM segment switch

  Six hours into a cast, when the Playbar moved gaplessly onto the next PCM segment, its reserve seemed to jump from
  about 495 ms to about 615 ms, though nothing was heard. A speaker reports its position on the first item it was told to
  play slightly ahead of the audio (about 110 ms on a Playbar, 210 ms on a Play:1), and on an item it moves on to by
  itself from the audio. Drift correction took the jump for surplus audio, removed it for most of an hour, and dragged its
  learned clock rate from +20 to +11 ppm, which would have taken hours to win back.
  - **The step is measured and absorbed.** At a switch the monitor measures the reserve on the new segment on its own,
    compares it with the reserve just before, and takes a difference of up to 400 ms off the new segment's readings, so
    the reserve carries on where it was. The log says how big the step was. A bigger step is treated as an underrun, as
    before, and a speaker restarted onto a segment is measured as it always was. A switch that follows an underrun by a
    few minutes is not measured, so the underrun is still reported.
  - **Later switches absorb nothing.** Only the first switch after the speaker was told to play has an offset. Later
    switches are still measured, and a step over 150 ms is still an underrun, but a smaller one is logged as steady and
    left alone: absorbing each one's measuring error had added up and drifted the reading. In the field the later
    switches all read slightly negative (-5 to -17 ms); whether that is real or how the speaker reports is not yet
    known. This only matters with short test segments.
  - **Drift correction carries on meanwhile, without the step.** Until the new segment is measured (about six minutes),
    drift correction steers by the reserve from before the switch, carried on along the speaker's clock, which has none
    of the step in it; the log shows `cmd=...(carried)`. Whenever the reserve has jumped in a way that may be an
    underrun, it holds at the clock rate it has learned, at once, and learns nothing from the jump
    (`cmd=...(settle)`). Notices stand as they were during the measurement. On a link too poor to measure the new
    segment within 15 minutes, the reserve is reported as read again, and drift correction holds until the step is
    measured. With 10-minute test segments, where a switch is being measured six minutes in every ten, drift
    correction now holds a slow speaker's reserve within about 30 ms (RMS) of its level from 100 minutes on in
    simulation, where holding through every measurement had left it hundreds of milliseconds off after hours.
  - **Short segments keep an accurate clock.** The clock estimate no longer starts over at every later switch, which
    with 10-minute segments had left it tens of ppm off after hours. A first switch measured before the clock is known
    is corrected once it is, which takes out about 17 ms of average error on a 45 ppm speaker.
  - **A first rough clock estimate no longer moves the reserve.** In the first minutes of a cast the clock rate was
    estimated at -465±161 ppm for a +19 ppm speaker, and even discounted it pushed the reserve up 24 ms and drift
    correction briefly removed audio. The clock rate now only moves the reserve estimate once its error is within 50 ppm.

- [#203](https://github.com/brew-lab/thaumic-cast/pull/203) [`6d543d8`](https://github.com/brew-lab/thaumic-cast/commit/6d543d84fdc1860e532368b457e6e5d62aab218a) Thanks [@skezo](https://github.com/skezo)! - fix(extension,desktop,server): give four messages the facts they were missing

  When Chrome refuses to let a tab be cast, the extension now shows the reason Chrome gave, where it gave one. Before, it
  could only say that no reason was written down.

  When one speaker drops out of a cast that is still playing on others, the extension now says the cast carries on
  without it. It used to show the same line as when the whole cast ended, which for some reasons told you to cast again
  while the cast was still running.

  In the desktop app, a notice that tells you to turn on clock drift correction now has the "Open Settings" button, as
  the notices about the speaker head start already did. With the button there, those notices no longer spell out where
  in Settings to look.

  Thaumic Cast Server now prints the address to enter in the extension once it is listening, for example "Listening on
  port 49400. The extension wants http://192.168.1.20:49400".

- [#137](https://github.com/brew-lab/thaumic-cast/pull/137) [`0342009`](https://github.com/brew-lab/thaumic-cast/commit/0342009aabfdc4848dd44e49363793d8e0040e98) Thanks [@skezo](https://github.com/skezo)! - fix(core): recover audio quality after stalls instead of skipping until restart

  After any underrun the cadence stream resumed on the very first frame, leaving the jitter buffer empty; with browser
  (WASAPI) capture delivering exactly one packet per tick it could never refill, so every later hiccup was an audible
  skip until the app was restarted. Playback is now held on silence until the queue is back at the configured jitter
  depth, with a timeout of twice that depth counted from when frames resume, and frames that arrived just before a
  tick no longer count as an underrun. On Windows, audio the engine discarded (`DATA_DISCONTINUITY`, measured from the
  device position and bounded by wall-clock time) is backfilled with the same duration of silence starting with a
  fade-out, packets flagged silent are zero-filled, and the first packet after a loss is faded in. Stream summaries now
  report `rebuffers`.

- [#212](https://github.com/brew-lab/thaumic-cast/pull/212) [`dd1bf05`](https://github.com/brew-lab/thaumic-cast/commit/dd1bf057cdffa6806ee3bad2fc55a4e5c3843564) Thanks [@skezo](https://github.com/skezo)! - refactor(extension,protocol): stop sending fields the companion never reads, and remove reconfigure()

  Internal tidying; nothing a listener can see or hear changes. When a cast starts, the extension no longer sends the
  companion its frame duration and latency mode. The companion reads neither: it works the frame duration out from the
  frame size, and the latency mode only steers the extension's own encoder. Both settings are stored and used in the
  extension as before. An encoder method that nothing called is gone. New tests hold the extension and the companion to
  the same smoothing, frame duration and speaker head start limits, and to the same handshake.

- [#187](https://github.com/brew-lab/thaumic-cast/pull/187) [`bfdf4ea`](https://github.com/brew-lab/thaumic-cast/commit/bfdf4ea18645fd0fdd8fac7a0fa5e30a2abe1b10) Thanks [@skezo](https://github.com/skezo)! - fix(core): treat a connection's declared end as an end, not a stall

  Each PCM connection now knows where the speaker takes it to end (the WAV header plus its data size, or less with a
  declared length or a test cap). From 2 s before that end until the connection closes, the speaker monitor samples no
  acknowledgement lag, measures no stall, decides no notice (head start ran out or close, running low, drift) and warns
  of nothing, the link verdict is not judged, and drift correction holds; the report line says `end=declared`. An end
  there is logged as `HTTP stream ended normally at its declared end` with the declared length, not as a stall, and the
  monitor's connection summary says the same. A speaker still reading a minute past its declared end is not honouring
  it, and is measured as before. This guards the segment ends the continuation work adds, and fixes the end line of a
  cast to a Playbar that reached the 4 GiB WAV length after 6h12m: it read on about 9 s past the length, hung up, and
  was logged as `(stalled)`.

  It does not remove the `head_start_ran_out` notice ("Wi-Fi held back 505 ms") raised in that cast. That came from a
  report about 8 s before the end: a single 88 ms acknowledgement lag on a reserve drift had drained to 83 ms, on a
  link judged poor, which the notice read as Wi-Fi holding back the whole head start. It is a separate problem.

- [#225](https://github.com/brew-lab/thaumic-cast/pull/225) [`88566a8`](https://github.com/brew-lab/thaumic-cast/commit/88566a8909eadea004760bf0551dd211991a199e) Thanks [@skezo](https://github.com/skezo)! - chore(deps): update the Rust dependencies, including quick-xml 0.42 and Tauri 2.12

  Takes the Rust updates dependabot proposed in [#188](https://github.com/brew-lab/thaumic-cast/issues/188) (tokio, reqwest, serde_json, mdns-sd 0.21, uuid, thiserror, Tauri 2.12 and its plugins, and others), and moves the Sonos XML parsing to quick-xml 0.42, which reads element names, attributes and text as UTF-8 strings rather than bytes. The parsed results are the same; the only difference is that a speaker reply that is not valid UTF-8 is now rejected rather than read with replacement characters. `windows-core` stays at 0.62 to match the `windows` crate.

- [#187](https://github.com/brew-lab/thaumic-cast/pull/187) [`0a7c6b6`](https://github.com/brew-lab/thaumic-cast/commit/0a7c6b67299c159410efc4eaa8d27a1c922d653e) Thanks [@skezo](https://github.com/skezo)! - feat(core): drive clock drift correction from the speaker monitor

  No two clocks agree exactly: a Sonos Playbar in the field plays about 20 ppm faster than audio arrives, so its reserve
  drains about 1.2 ms a minute and a 500 ms speaker head start reaches the low floor after roughly five hours. The core
  now has a controller that holds each speaker's reserve at the level its head start settled at, by commanding the PCM
  rate adapter to stretch or squeeze the audio by at most 150 ppm. It steps on every 30 s reserve estimate: a
  proportional term beyond a deadband that follows the estimate's half-width, a gentler damping term inside it, and an
  integral that learns the speaker's clock, is kept across reconnects and casts (by speaker UUID where the topology
  knows it), never winds up against the cap, and is frozen on held or unlocked estimates. The command holds while the
  estimate is unlocked and ramps to 0 after 30 minutes unlocked or 10 without answers; it is refreshed every 500 ms, so
  if the monitor stops the cadence's watchdog drops it to 0 within 30 s. The reserve estimate and the time to the floor
  use the net rate (the clock less the correction applied), video sync counts the audio inserted, and the 30 s
  `[SpeakerMonitor]` line shows `cmd` (or `would_cmd`), the integral and `ins`. Speaker health reports carry `driftMode`,
  `commandPpm` and `netInsertedMs`; a `drift_saturated` notice says when correction is pinned at its cap and the speaker
  will still run low, and an uncorrected drift notice now adds that turning correction on keeps the speaker topped up.

  The mode is `on`, `observe` or `off`, read per connection and `off` whenever speaker monitoring is. With `observe`
  the controller works out and logs what it would command while the audio goes out byte for byte as captured; the
  default is set in the `drift-default-on` changeset. The desktop app offers an On/Off toggle under Settings > Speakers (Off keeps observing), disabled while
  "Speaker monitoring" is off; the server takes `drift_compensation` in its config or `--drift-compensation`, and warns at startup
  when it is set but the speaker monitor is off. `THAUMIC_DRIFT_COMPENSATION` outranks both.

- [#196](https://github.com/brew-lab/thaumic-cast/pull/196) [`a759d82`](https://github.com/brew-lab/thaumic-cast/commit/a759d821816821449dc51129d2cef7d7336deecb) Thanks [@skezo](https://github.com/skezo)! - feat(core): turn clock drift correction on by default

  No two clocks agree exactly, so over a long cast a speaker slowly uses up its head start and eventually cuts out.
  Clock drift correction stretches or squeezes the audio by a tiny amount (at most 150 parts per million, far too little
  to hear) to keep each speaker topped up. It is now on unless you say otherwise. In long runs on a Playbar and a Play:1
  (3 and 9.4 hours) it held each speaker's reserve within a few milliseconds of where it started, where an uncorrected
  speaker lost about 85 ms in the first hour.
  - **Desktop app:** "Clock drift correction" under Settings > Speakers starts ticked. A setting already saved in
    the settings file is kept; no released version has one, so this only affects builds made from the main branch since
    the option was added, where saving any speaker setting also stored the old `observe`. Unticking it leaves the audio exactly as captured and keeps logging what correction would do.
  - **Server:** a config file without `drift_compensation` now gets `on`. A config file that sets it keeps its value;
    write `drift_compensation: observe` (or `off`) to go back.
  - `THAUMIC_DRIFT_COMPENSATION` still outranks both.
  - Correction needs speaker monitoring ("Speaker monitoring" / `speaker_monitor`), which is also on by default.
    With monitoring off, correction is off, as before.
  - PCM casts only, as before.
  - With correction on, a PCM cast that has to restart at a segment boundary keeps up to 2 s of the pause as extra delay
    and pays it back gradually, instead of rejoining with only its head start.

- [#187](https://github.com/brew-lab/thaumic-cast/pull/187) [`26d1a53`](https://github.com/brew-lab/thaumic-cast/commit/26d1a53a93a5d20a99600c9b14d3771f0d3e3ce3) Thanks [@skezo](https://github.com/skezo)! - feat(core): add THAUMIC_DRIFT_FORCE_PPM for blind listening tests of the rate adapter

  Set to a number from -300 to 300, it fixes every monitored speaker's PCM rate adapter at exactly that many ppm,
  whatever the drift correction mode and the controller say. It is read for each connection, each connection it applies
  to logs a warning that it is for listening tests only, and the 30 s `[SpeakerMonitor]` line shows `forced=` (with
  `(pinned)` once the 2 s insertion limit holds the adapter at 0 ppm). The drift controller does not learn while a rate
  is forced. A value that is not a number in range is ignored with a warning, logged once per value, and with it unset
  nothing changes.

- [#187](https://github.com/brew-lab/thaumic-cast/pull/187) [`ec00cd8`](https://github.com/brew-lab/thaumic-cast/commit/ec00cd86d07b0811bd08cdb3740caa5520a49434) Thanks [@skezo](https://github.com/skezo)! - fix(core): let drift correction learn a speaker's clock from its measured rate

  Drift correction learned how fast a speaker's clock runs from the reserve alone, slowly: on the Playbar (+19 ppm) it had
  learned +6.7 ppm after half an hour and +12.9 after an hour, and reached about +18.4 at 93 minutes and +20.4 at 103.
  Meanwhile the reserve sat off its level (on a Play:1 about 45 ppm slow, 80-100 ms high) and the correction was busier
  than it needed to be. The monitor measures the same clock rate directly, and after 35-45 minutes of an unbroken cast it
  claims a standard error under 10 ppm.

  From then on each reserve estimate also draws the learned rate a little way towards the measured one, never more than
  0.5 ppm at a time, so a 20 ppm gap takes about 20 minutes to close: the more precise the measurement and the less the
  correction has learned about the speaker yet, the further. The measured rate's standard error says how much it
  scatters, not how far off it is, and late in a cast it claims too little (the Playbar's claimed ±0.5 ppm while it moved
  by 3.5), so it counts as no better than ±3 ppm. A measurement over less than 30 minutes draws nothing. The monitor line
  shows how long the correction has learned the speaker and how far the measurement drew it on each report
  (`I=+17.7 taught=93m pull=+0.12ppm`).

  In simulation, over casts to speakers from 60 ppm fast to 45 ppm slow, the learned rate is a median 3.2 ppm off an hour
  in, where it was 10.8, and the reserve settles within 40 ms of its level about 20 minutes sooner. On the speakers that
  drift, it overshoots its level after the first half hour by a median 4.2 ms where it did by 10.2 (90th percentile 13
  where 19). Not every cast gains: about 5% of casts to a new speaker overshoot a little more than they did, by up to
  9 ms, and about 10% of those to a speaker the correction has partly learned already, by up to 10 ms. A speaker the
  correction has learned during an earlier cast is barely moved. With 10-minute test segments the measurement is precise
  by the hour and the same holds.

  A switch away from the item the speaker was told to play now always restarts the clock measurement, as it did only
  after an item of three minutes or more: after a two-minute first item the reporting step left in the measurement put it
  a mean 10-12 ppm off at 40 minutes in simulation, just as it starts to draw the learned rate.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`cf20652`](https://github.com/brew-lab/thaumic-cast/commit/cf20652d56356f2ba8c4bfad6cebdc43e2b951b6) Thanks [@skezo](https://github.com/skezo)! - fix(core): anchor the playback epoch to the first frame served

  A speaker's playback epoch, the capture time its RelTime 0 corresponds to, was taken from the oldest frame in the
  stream's 500 ms ring, but the PCM cadence serves only the newest jitter buffer's worth of that ring. Whenever the ring
  was full when the speaker connected, which is any fetch arriving more than half a second after audio started and every
  reconnect, the epoch sat up to 300 ms before the first frame the speaker actually played, so every latency and cushion
  measured on that connection read up to 300 ms too high. The epoch is now the capture time of the first frame kept
  after trimming. Reported video-sync latency drops by the same amount; that is a correction, not a regression.

- [#136](https://github.com/brew-lab/thaumic-cast/pull/136) [`bb3da36`](https://github.com/brew-lab/thaumic-cast/commit/bb3da36f91ad14ad55e23e5f35bddd419146cf04) Thanks [@skezo](https://github.com/skezo)! - feat(extension): ask for permission to reach a companion on another machine

  When you enter a custom server URL and click Connect (previously "Test"), Chrome now prompts once to allow that address, scoped to that
  origin only. This replaces the companion's CORS layer, which trusted every installed browser extension and wrapped the
  API in middleware; the HTTP API no longer sends CORS headers.

- [#134](https://github.com/brew-lab/thaumic-cast/pull/134) [`e4121e2`](https://github.com/brew-lab/thaumic-cast/commit/e4121e2f3bfb5e701b6e0d2ef704d565bfee2329) Thanks [@skezo](https://github.com/skezo)! - fix(core): allow the extension to reach a companion on another machine

  The extension only has host permission for `localhost`, so every request to a remote headless server was blocked by
  CORS. The HTTP API now answers CORS for `chrome-extension://` and `moz-extension://` origins only; regular web pages
  remain unable to read responses.

- [#187](https://github.com/brew-lab/thaumic-cast/pull/187) [`2449f4b`](https://github.com/brew-lab/thaumic-cast/commit/2449f4b2f4158b5ebb49c322198430bbf9a6d549) Thanks [@skezo](https://github.com/skezo)! - fix(core): stop blaming the first-connection wait when a speaker rejects the stream at once

  When a speaker's first connection ended within 100 ms of its first bytes, the log still said the first-connection wait
  was not survived and suggested a shorter speaker head start. A speaker that hangs up that soon has already sat through
  the wait, so the warning now says the speaker ended the connection right after the stream started, which can mean it
  rejected the stream (for example an invalid WAV header), unless the cast was stopped. An end later than that keeps the
  wait-specific warning.

- [#192](https://github.com/brew-lab/thaumic-cast/pull/192) [`0102d46`](https://github.com/brew-lab/thaumic-cast/commit/0102d468dde27a1ce38cb00835fafbd6b6d51d56) Thanks [@skezo](https://github.com/skezo)! - fix(core): keep a very long track title from corrupting an AAC stream

  The title sent to a speaker inside an AAC stream has a size limit of about 4,000 bytes. A longer title (or a shorter one
  with many apostrophes, each of which takes three bytes once sent) overflowed the size marker, so the speaker read the
  title text as audio. A title over the limit is now shortened to fit, without splitting a character.

- [#214](https://github.com/brew-lab/thaumic-cast/pull/214) [`36921ac`](https://github.com/brew-lab/thaumic-cast/commit/36921ac85862f3dea2c256b0c1cb423240ceed25) Thanks [@skezo](https://github.com/skezo)! - refactor(core): move the shared vocabulary types to a leaf module

  An internal restructuring with no behaviour change. The small types that events carry and the stream path reads
  (the drift correction mode, speaker notices, topology member changes, the playout timeline and the PCM connect burst
  setting) now live in one module with nothing above it, so the stream and event code no longer import from the
  services. Every existing path still works.

  One thing differs in the logs: the warning that a PCM connect burst is above the maximum now prints the module path
  `thaumic_core::model::head_start` instead of `thaumic_core::stream::cadence`. Its text is the same.

- [#216](https://github.com/brew-lab/thaumic-cast/pull/216) [`7bc0f6f`](https://github.com/brew-lab/thaumic-cast/commit/7bc0f6f97dc1f9600875958049e9e2e21f171e56) Thanks [@skezo](https://github.com/skezo)! - refactor(core): move the TCP link probe under the stream module

  An internal restructuring with no behaviour change. The link probe (the TCP window sampling, the registry and the
  judge that turns samples into a link quality) never used anything from the API layer, and the stream cadence is what
  reads it. It now lives beside the stream code, so the stream module no longer imports from the API module. The old
  `thaumic_core::api::link` path still resolves.

  One thing differs in the logs: lines emitted from this file now print the module path `thaumic_core::stream::link`
  instead of `thaumic_core::api::link`. Their text is the same.

- [#187](https://github.com/brew-lab/thaumic-cast/pull/187) [`0b9769b`](https://github.com/brew-lab/thaumic-cast/commit/0b9769b84fc3aacb3abd6c52e27720eaf17756a9) Thanks [@skezo](https://github.com/skezo)! - fix(core): log a grouped member's grace ending at debug when it still plays

  After every grouped gapless switch the log said a speaker joined to the coordinator "did not report PLAYING within
  5000 ms". Members report nothing at all through a gapless switch and their recorded state stays PLAYING, so that is
  the normal path: it is now logged at debug, and at info only when the state clients are then shown is not PLAYING
  (STOPPED after a restart, say). The line names that state. The member is released after the grace as before.

- [#187](https://github.com/brew-lab/thaumic-cast/pull/187) [`8dd0624`](https://github.com/brew-lab/thaumic-cast/commit/8dd06246e7bb9d46cd97738c3a707b68ff199ed1) Thanks [@skezo](https://github.com/skezo)! - fix(core): blame the clock, not Wi-Fi, when drift drained a speaker that then ran out

  Six hours into a cast the Playbar's clock (+19.3 ppm) had drained its reserve from about 510 ms to about 83 ms. One
  acknowledgement lag of about 88 ms on its always-poor link then put the acknowledged reserve at -5 ms, and the speaker
  was told "Wi-Fi trouble held back 505 ms of audio" with a 750 ms head start as the fix. Both were wrong: 505 ms was the
  head start less the minimum, most of it taken by the clock over hours, and a longer head start drains the same way.
  - **Drift first.** A speaker whose clock drained at least half of what its reserve lost before a stall came, by the
    rule running low's drift cause uses and judged from the reserve's median rather than a minimum the stall pulled down,
    gets no head-start notice for a stall that runs it out, whether or not the reserve was below the floor yet. Running
    low, with `cause: "drift"`, says what happened and offers drift correction and a restart. An underrun seen only as
    an offset step is judged the same way from the window before the break, when that was already running low.
  - **Unless the stall alone was too much.** A stall that would have run the speaker out from a full reserve too (more
    than the head start less its floor) is still a head-start notice, and on a drift-drained speaker it reports the
    stall measured, never the head start less the minimum.
  - **A poor link no longer hides the drift.** Running low's drift cause no longer requires a good link: a speaker whose
    link is always lossy drifts like any other, and a poor link alone never turns a drift-drained reserve into a Wi-Fi
    notice.

  A thin reserve hit by a loss burst the clock does not explain (the 2026-09-28 Playbar underrun) is a head-start notice
  as before.

  A standing notice that gains its cause in place is now logged, under the same id.

- [#187](https://github.com/brew-lab/thaumic-cast/pull/187) [`82ee895`](https://github.com/brew-lab/thaumic-cast/commit/82ee89570e9835f8d656cfc082a7230441e6637e) Thanks [@skezo](https://github.com/skezo)! - fix(core): serve PCM streams chunked so a cast to a Playbar no longer stops after 3h06m

  A PCM cast to a Sonos Playbar stopped after 3h06m, exactly 2^31 bytes at 48 kHz stereo: PCM declared a
  `Content-Length` of 4294967295, and the Playbar caps a declared length at 2^31. PCM is now served like every other
  codec, with no `Content-Length`: chunked to an HTTP/1.1 client, and to an HTTP/1.0 client as an HTTP/1.0 response that
  ends only when the connection closes. The WAV header still declares 0xFFFFFFFF in both size fields, and with no length declared
  the Playbar played on past the 2^31 boundary in a field test with its reserve intact. A run then stopped at exactly
  2^32 bytes (6h12m50s): the header's 0xFFFFFFFF is a length the Playbar obeys, so a cast now stops after 6h12m instead;
  continuing past it is a follow-up. The fixed length was first added because Sonos was thought to stutter on chunked WAV; that
  stutter was the speaker's thin reserve, which the speaker head start fixed. `THAUMIC_PCM_HTTP_FRAMING=length` still
  serves the old 4294967295-byte length for comparison, and `close` stays available, both experimental. The speaker
  monitor's acknowledged-bytes lag counts the chunk framing, so it stays right on a chunked PCM connection.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`e9e0686`](https://github.com/brew-lab/thaumic-cast/commit/e9e0686602428ca431ff8a3ed98803cce17c6c0f) Thanks [@skezo](https://github.com/skezo)! - feat(core): send each speaker a burst of audio when it starts fetching a PCM stream

  A PCM (WAV) stream was paced at real time from its very first frame, so a speaker never held more than a few tens of
  milliseconds of audio ahead of its playhead, and a Wi-Fi loss burst longer than that was heard as a stutter. Raising the
  network buffer only deepened the server's own queue. When a speaker's fetch starts, including a reconnect or resume, the
  server now sends it up to 500 ms of already-captured audio as fast as the connection takes it, then paces the rest
  exactly as before, with the full jitter buffer still queued on the server. A speaker's first connection waits, before
  the response starts, until the stream holds the burst as well as the jitter buffer (700 ms at the defaults, counted from
  the stream's first frame), so a fresh cast gets the whole burst. That wait is not capped, so a large burst adds as much
  to it; it is logged, and so is whether the speaker kept its connection through it, which shows whether a speaker accepts
  a long one. A resume is never delayed and bursts only what the stream holds beyond the jitter buffer, never padding with
  silence. End-to-end latency grows by the burst; the playback epoch is anchored to the first burst frame, so video sync
  and the speaker monitor's reserve account for it. A PCM stream's ring now holds the largest burst plus the largest
  jitter buffer, which also fixes jitter buffers above 500 ms being silently capped at 500 ms. Compressed codecs are
  unaffected. The burst, called the speaker head start in the apps, is set in the desktop app under Settings > Speakers
  (Off, or 250 to 2000 ms), with `pcm_connect_burst_ms` in the server's config.yaml, or with
  `THAUMIC_PCM_CONNECT_BURST_MS`, which outranks both (0 turns it off, at most 2000). It applies from each speaker's next
  connection, to PCM casts only.

- [#187](https://github.com/brew-lab/thaumic-cast/pull/187) [`b52baa9`](https://github.com/brew-lab/thaumic-cast/commit/b52baa9d349a1a334e9d923374e38ad914daf1f1) Thanks [@skezo](https://github.com/skezo)! - feat(core): queue the next PCM segment for a gapless handoff

  A PCM cast now moves from one segment to the next with no audible switch. Ten seconds after the coordinator reports
  PLAYING on a segment, the server queues the next one as its next item (`SetNextAVTransportURI`, with the same
  broadcast DIDL-Lite the cast starts with). A Sonos speaker fetches it the moment the current segment's body ends, plays
  out what it holds and switches with no STOPPED: in a hardware probe on S2 86.10 a Playbar switched about 1.2 s after the
  server's end and a Play:1 group about 3.8 s after, three boundaries out of three each, and the switch could not be
  heard. The playout carries on sample for sample, so nothing is skipped or repeated.
  - **Never two ahead.** Only the segment after the one the speaker reports playing is queued, never the one after that
    while the next is still pending (the probe skipped a segment doing that during a pause). A queue that an event shows
    cleared, by a `SetAVTransportURI` or a resume, is queued again; the new `NextAVTransportURI` field of the GENA
    transport event says what is queued. Sonos shows a queue cleared by `SetAVTransportURI` only on the STOPPED or
    TRANSITIONING after it, so that event drops the queued segment and the PLAYING after it queues it again. Nothing is queued while paused, during a switch, or with less than 15 s of the
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

- [#187](https://github.com/brew-lab/thaumic-cast/pull/187) [`f833ba4`](https://github.com/brew-lab/thaumic-cast/commit/f833ba45fb46cddcc4802af40fc3977b907a50fa) Thanks [@skezo](https://github.com/skezo)! - feat(core): restart a PCM cast at the segment boundary

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

- [#205](https://github.com/brew-lab/thaumic-cast/pull/205) [`96fa854`](https://github.com/brew-lab/thaumic-cast/commit/96fa854a3ed9afd3cb8cb66a8f93402ec8ac0d78) Thanks [@skezo](https://github.com/skezo)! - fix(extension,core): a PCM cast declares the rate it was captured at

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

- [#187](https://github.com/brew-lab/thaumic-cast/pull/187) [`9210ec5`](https://github.com/brew-lab/thaumic-cast/commit/9210ec5e020380a85406e0decddf9621dc3613f4) Thanks [@skezo](https://github.com/skezo)! - feat(core): add test switches for how a PCM stream is framed over HTTP

  A PCM cast to a Playbar stopped after exactly 2^31 bytes, and the speaker may be obeying the declared `Content-Length`,
  the size fields in the WAV header, or a counter of its own. Four environment variables, read again for each speaker
  connection, let a field experiment change one of these at a time without a rebuild. `THAUMIC_PCM_HTTP_FRAMING` picks
  `length`, `chunked` (no length) or `close` (an HTTP/1.0 response with `Connection: close`, ended only by closing the
  connection). `THAUMIC_PCM_CONTENT_LENGTH` sets the length declared with `length` framing. `THAUMIC_PCM_WAV_DATA_SIZE`
  sets the WAV header's data size (0 to 4294967295), with the RIFF size to match. `THAUMIC_PCM_END_AFTER_BYTES` ends each
  body cleanly from our side after that many bytes, logged as `ended_by=server_cap`; it is refused with `length` framing,
  where ending early would abort the connection. A connection served with any of them set logs a `[Stream] PCM HTTP
switches` line, and an invalid value (including one that is not valid UTF-8), or one that does not apply to the chosen
  framing, is ignored with a warning. These switches are for field experiments only; the WAV header keeps 0xFFFFFFFF in
  both size fields (a 4 GiB length, not an unbounded marker) unless one says otherwise, and every stream response keeps its headers in the same order as before. The
  experiments found the 3h06m stop, and PCM is now chunked by default (see the change that serves PCM chunked). The
  speaker monitor's acknowledged-bytes lag already counts chunk framing, so it stays right on a chunked PCM connection.

- [#187](https://github.com/brew-lab/thaumic-cast/pull/187) [`3df26cb`](https://github.com/brew-lab/thaumic-cast/commit/3df26cb7bfcdde5bf249eee75565ca80be4b3e75) Thanks [@skezo](https://github.com/skezo)! - feat(core): carry a PCM playout across segment connections

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

- [#187](https://github.com/brew-lab/thaumic-cast/pull/187) [`63c6637`](https://github.com/brew-lab/thaumic-cast/commit/63c663751923cbfce0ba577bfaa73c6e5cd77261) Thanks [@skezo](https://github.com/skezo)! - fix(core): log how each speaker fetch is framed and why it ended

  A speaker's fetch was logged as "ended normally" whether the speaker hung up, hyper stopped at the declared
  `Content-Length`, or the cast was stopped, so a PCM cast that stopped after hours could not be explained from the log.
  The `[Stream] New connection` line now gives the request's HTTP version (`http=`), how the body is delimited
  (`framing=length|chunked|close`) and the length it declares (`declared_len=`), and a Range request gets the same line at
  info level with its range instead of a debug line. Both `HTTP stream ended` lines now give the payload handed over
  (`bytes_sent=`), the bytes that put on the wire including chunk framing (`wire_bytes=`), and who ended it (`ended_by=`):
  `client` when the speaker went away, `length` when hyper wrote the whole declared length, `server_shutdown` when the
  stream ended on our side, `error` when the body failed, and `server_cap` for a test cap that a later field experiment
  adds. These are diagnostics for field experiments; they do not change what is served. The speaker monitor's
  acknowledged-bytes lag is now counted against the bytes on the wire, which only differs on a chunked body: counted
  against the payload, the chunk framing let the acknowledged count overtake it within minutes and the lag read zero.

- [#223](https://github.com/brew-lab/thaumic-cast/pull/223) [`8834cdc`](https://github.com/brew-lab/thaumic-cast/commit/8834cdc41953c989fa7f84390cb39e37ac75b7b7) Thanks [@skezo](https://github.com/skezo)! - refactor(core): finish the speaker monitor rename and move the settings' names into model

  An internal tidy-up after the refactor, with no behaviour change. The field that holds the speaker monitor is now
  called `speaker_monitor` everywhere, not `latency_monitor`. The environment variable names for speaker monitoring and
  drift correction, and the parser for the monitoring switch, now live in `model` beside the other setting types, so
  the code that resolves the companion settings no longer reaches up into the services for them; the old paths still
  work. The crate's module list, the rule for what `model` may use, and a few broken documentation links were corrected
  to match the code.

- [#191](https://github.com/brew-lab/thaumic-cast/pull/191) [`ca7f19d`](https://github.com/brew-lab/thaumic-cast/commit/ca7f19dfa1385c2a4bd7cb1d18074a8d9f5215ad) Thanks [@skezo](https://github.com/skezo)! - fix: refuse a codec the companion cannot stream, and say so

  If the extension asked for a codec the companion has no stream for, the companion quietly treated the audio as PCM, so
  the speaker was handed something it could not play. The companion now refuses the cast and names the codec. Its refusals
  also reach the extension: they were sent in a shape the extension discarded, so a refused cast only ever showed a
  connection close code. The reason the companion gives is now what the failed cast reports, including from a companion
  that has not been updated yet.

  Ogg Vorbis is no longer offered, because the companion never had a stream for it. A custom quality setting saved with
  Ogg Vorbis becomes AAC-LC, keeping its bitrate where AAC-LC has the same one.

  Starting playback of a stream that has already gone now fails with "Stream not found" for each speaker, where it used
  to send the speakers an AAC address on a guess.

- [#194](https://github.com/brew-lab/thaumic-cast/pull/194) [`d8efc83`](https://github.com/brew-lab/thaumic-cast/commit/d8efc833ce9a7dab677cea30d9e490fbe72c25f6) Thanks [@skezo](https://github.com/skezo)! - fix(extension): remove the HE-AAC options, which were AAC-LC under another name

  The HE-AAC and HE-AAC v2 choices are gone from the custom quality settings. The browser encodes plain AAC-LC whatever
  kind of AAC it is asked for (measured on Chrome and Edge on Windows, where all three choices gave exactly the same audio
  at the same bitrate), so they never sounded or behaved differently from AAC-LC.

  AAC-LC gains 96 and 160 kbps, so a low-bitrate option is still there. A bitrate the browser cannot encode on your
  machine is not listed (256 kbps on Windows). Choosing AAC-LC in the custom settings starts at 192 kbps, its usual
  bitrate, not at the lowest one.

  The Economical preset now says what it sends: AAC-LC at 96 kbps, where on Windows it used to say HE-AAC v2 at 96 kbps
  for the same audio. Where it used to pick 64 kbps it now uses 96 kbps.

  A custom setting saved with HE-AAC or HE-AAC v2 becomes AAC-LC at the nearest bitrate (64 kbps becomes 96 kbps), and
  the change is saved the first time the settings are read, without dropping the connection to the companion.

  The companion still accepts both HE-AAC names from an extension that has not been updated. Its only change is that the
  message for a codec it does not know no longer lists them.

- [#187](https://github.com/brew-lab/thaumic-cast/pull/187) [`67f86db`](https://github.com/brew-lab/thaumic-cast/commit/67f86db9a81fc1c9ed6850af9a3c91a66c0d350d) Thanks [@skezo](https://github.com/skezo)! - feat(core): say when clock drift made a speaker run low

  On a long cast the drift notice came first and running low then replaced it for the rest of the cast, saying only
  how much audio the speaker had left: the cause and the remedy were gone. A running-low notice now carries
  `cause: "drift"` when the speaker's clock is measurably draining the reserve, net of any correction, by at least
  5 ppm, has drained at least half of what the reserve lost since it settled, and no stall or poor link explains the
  loss. The popup and the dashboard then add that the speaker plays slightly faster than the audio
  arrives, offer clock drift correction where it is not on (as the drift notice does), and keep the restart advice.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`7f55220`](https://github.com/brew-lab/thaumic-cast/commit/7f55220cf370c7af777d7f520b5d8f386c8c41b5) Thanks [@skezo](https://github.com/skezo)! - build(core): pass clippy on Rust 1.99

  Rust 1.99 deprecates `AtomicUsize::fetch_update` and its clippy flags the `#[must_use]` that async-trait 0.1.91
  put on trait methods. The two `fetch_update` calls are now compare-exchange loops, which also build on the
  declared minimum Rust 1.77, and async-trait is updated to 0.1.92. No behaviour change.

- [#133](https://github.com/brew-lab/thaumic-cast/pull/133) [`0ccd8a9`](https://github.com/brew-lab/thaumic-cast/commit/0ccd8a98ef72eac1fa34e9379198d0858a598e49) Thanks [@dependabot](https://github.com/apps/dependabot)! - build(deps): update Rust dependencies

  Bumps 26 crates, notably quick-xml 0.39 → 0.41, mdns-sd 0.19 → 0.20 and tower-http 0.6 → 0.7, and adapts the XML
  text readers to quick-xml's new `BytesText` return type. No behaviour change.

- [#187](https://github.com/brew-lab/thaumic-cast/pull/187) [`832fa75`](https://github.com/brew-lab/thaumic-cast/commit/832fa751e116c86fc942892adf8d5e091bd2d182) Thanks [@skezo](https://github.com/skezo)! - refactor(core): match stream URIs by stream id so segment URLs stay one session

  A WAV header can declare at most 4 GiB, so the continuation work serves a long PCM cast as consecutive segments,
  each under its own URL: segment 0 is the `/stream/{id}/live.wav` every PCM cast has always used, and segment `n` is
  the new `/stream/{id}/live/{n}.wav`. The server now answers that route (through the same per-stream access check;
  anything but a canonical `{n}.wav` on a PCM stream is a 404), and names the segment in the new-connection line.
  Until segments are carried across connections, a segment is served from the live edge like `live.wav`.

  A speaker moving on to a later segment must not look like a new source. The GENA source-change check compared the
  speaker's `CurrentTrackURI` with the session's URL exactly, so the first segment switch would have ended the cast as
  `SourceChanged`. It now compares host and stream id, so every segment of a cast is one session, while another app,
  another client's cast or the Sonos TV input taking a Playbar over still ends it. Sessions keep the stream's base URL
  for their whole life, so a coordinator promoted mid-cast starts on segment 0 and its later segments match too.
  Redaction of other clients' stream URLs in Sonos events covers segment URLs as well.

- [#220](https://github.com/brew-lab/thaumic-cast/pull/220) [`52c2f28`](https://github.com/brew-lab/thaumic-cast/commit/52c2f289d5b215176a821c9c9f0b206f797ee435) Thanks [@skezo](https://github.com/skezo)! - refactor(core): name the phases of the stream handler

  An internal restructuring with no behaviour change. The function that answers a speaker's fetch of a stream was about
  600 lines long. Eight of its phases are now functions of their own in the same file: admission, framing and the fetch
  log, segment routing, guard construction, playout statistics, the tap and epoch hook, the body pipeline and response
  assembly. Each is the same statements as before, run at the same point.

  The part that decides between a resume and a first connection, waits before the first response and subscribes to the
  stream is left where it was, untouched. Nothing is awaited anywhere else, every log line is the same and is written in
  the same order, and the module path the log lines print is unchanged.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`921110c`](https://github.com/brew-lab/thaumic-cast/commit/921110c2c05b2d2af9689de4d10279848e4d538d) Thanks [@skezo](https://github.com/skezo)! - fix(server): validate configuration instead of failing later

  A topology refresh interval of zero was accepted and then panicked inside a background task, aborting the release
  binary and leaving a service manager to restart it repeatedly with an unhelpful message. Configuration is now checked
  at load with a clear error, the monitor clamps the interval defensively, and environment variables are read in one
  place so an invalid value is reported rather than ignored.

- [#134](https://github.com/brew-lab/thaumic-cast/pull/134) [`bffd1da`](https://github.com/brew-lab/thaumic-cast/commit/bffd1dac35de6af3ec0c1f9bdf7a2287afdcf741) Thanks [@skezo](https://github.com/skezo)! - fix(server): stop panicking at startup and serve audio on the streaming runtime

  `thaumic-server` aborted immediately with "Cannot block the current thread from within a runtime" because the
  streaming runtime blocked on a channel from inside `#[tokio::main]`. The runtime is now built on the calling thread
  and handed to a keeper thread, so nothing blocks and it can be created from any context. The server also serves
  HTTP on that runtime, as the desktop app does, so its priority-elevated workers carry the audio path instead of
  sitting idle.

- [#145](https://github.com/brew-lab/thaumic-cast/pull/145) [`515a5cc`](https://github.com/brew-lab/thaumic-cast/commit/515a5cc3ff66a0518c920991bcce90a874058446) Thanks [@skezo](https://github.com/skezo)! - fix(core): read the error code from Sonos SOAP faults

  A Sonos speaker reports every fault with the same `faultstring` and puts the meaning in the fault detail, but the
  code was being looked for in the faultstring, so it was never found. As a result a speaker answering "transition not
  available" while it changed states was treated as a hard failure instead of being retried, and a stop sent to a
  speaker that had already stopped was reported as an error. The code is now read from the detail, retries happen on the
  transient codes as intended, and an already-stopped speaker counts as stopped.

- [#223](https://github.com/brew-lab/thaumic-cast/pull/223) [`82a3673`](https://github.com/brew-lab/thaumic-cast/commit/82a3673824d20f04f7463cdff93cff25685767bf) Thanks [@skezo](https://github.com/skezo)! - fix(core): rewrite only the leading scheme of an MP3 or AAC speaker URI

  MP3 and AAC streams are handed to a speaker as an `x-rincon-mp3radio://` URI. The function that builds it replaced
  every `http://` or `https://` in the URL, not only the one at the start, so a URL that carried another address later
  on (in a query string, say) had that address rewritten too. It now replaces only the leading scheme. The stream URLs
  the companion builds today never contain a second scheme, so the URIs speakers are given do not change.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`921110c`](https://github.com/brew-lab/thaumic-cast/commit/921110c2c05b2d2af9689de4d10279848e4d538d) Thanks [@skezo](https://github.com/skezo)! - fix(core): decode Sonos XML entities exactly once on both parser paths

  Attribute values were returned without decoding, so a room named with an apostrophe or an ampersand kept its escaped
  form when read from a direct request, while the event path decoded the same document twice and produced malformed XML
  that only parsed because of the order Sonos happens to send state variables in. Room names now match on both paths,
  and the event path parses fields that follow track metadata instead of stopping at it.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`90173c4`](https://github.com/brew-lab/thaumic-cast/commit/90173c48c3afcf6c0a54bb26e6d7e5d856048ad2) Thanks [@skezo](https://github.com/skezo)! - feat(core): read acked bytes from the speaker socket

  The reserve estimate counts delivered audio as what the response body has yielded, which runs ahead of what the
  speaker holds whenever the socket backs up, so a retransmission stall that briefly empties the speaker never showed in
  it. The TCP statistics read every 500 ms now include the bytes the speaker has acknowledged, counted from when the
  stream claims the connection so earlier responses on a kept-alive socket are left out: on Linux from a `tcp_info`
  prefix whose later fields are trusted only when the length the kernel returns covers them, on Windows as bytes sent
  less bytes in flight, net of retransmissions once a connection shows this machine's stack counting them (an excess the
  resent bytes do not explain is reported as unknown, never learned from). Each pipeline snapshot carries the bytes not
  yet acknowledged, and the speaker monitor takes the lowest reserve, the drain projection and a new `low` alarm on
  acknowledged audio (see the reserve floor entry for when a speaker counts as low), so a retransmission stall shows in
  them. The 30-second line shows the acknowledged minimum and 10th percentile beside the target, and platforms without
  acknowledgements fall back to the delivered count.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`602c9ee`](https://github.com/brew-lab/thaumic-cast/commit/602c9ee2ff71b41f4added085bda4a48c1d1154c) Thanks [@skezo](https://github.com/skezo)! - fix(core): make two clients choosing one speaker safe

  Sessions are indexed by speaker as well as by stream, and only one entry per speaker is kept in that index, so two
  clients starting on the same speaker at once left an entry that lookups by speaker could never find and cleanup never
  reached. Starting playback now takes a lock for that speaker, covering the grouped path as well, so the sequences
  cannot interleave. The later client still takes the speaker; only the leftover state was wrong.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`c4e8020`](https://github.com/brew-lab/thaumic-cast/commit/c4e80207c989d287844f6a459d4c2cdba4ec1f56) Thanks [@skezo](https://github.com/skezo)! - feat(core): log each speaker's playback cushion and its trend

  Every playing speaker is now polled for its playback position, not only when video sync asks for it, and the log
  gets a line every ten seconds with how much audio the speaker holds ahead of its playhead and how that figure is
  trending. A warning is written when the cushion is nearly gone, and when it is shrinking steadily enough to run out
  within the session, which is what a speaker whose clock runs ahead of the source's looks like. A stream can look
  perfect on the server and still go choppy for good when that cushion drains, and nothing else in the log could see it.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`09d86b0`](https://github.com/brew-lab/thaumic-cast/commit/09d86b033f9b2db0408d7066839a25a9a158db1d) Thanks [@skezo](https://github.com/skezo)! - feat(core): report each monitored speaker's buffer health to the client casting to it

  The speaker monitor measured how much audio each fetching speaker held ahead of its playhead, how fast its clock
  drained that, and when the reserve ran low, but only the log could see it. The server now sends a speakerHealth
  network event with the state (locking, ok, draining, low, paused, stale or dormant), the reserve and its precision,
  the lowest and 10th-percentile acknowledged reserve over the window, the level the reserve settled at, the speaker
  head start the connection was sent and configured, the floor the low state is judged against, the window's stall, the
  clock rate and the projected time to the floor. It goes out with every 30 s report and at once when the state changes,
  only while the speaker is monitored, and only to the client that owns the stream while it is live. The desktop app
  relays it to its frontend as a speaker-health event. Drift compensation is not built yet, so the event carries no
  compensation fields; they can be added later without breaking older clients.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`099c4d2`](https://github.com/brew-lab/thaumic-cast/commit/099c4d2389497c179cc4facbaba7a04e99f44f40) Thanks [@skezo](https://github.com/skezo)! - feat(core): log when the network path to a speaker is unstable

  Field testing showed the stream to a speaker stuttering exactly when the Wi-Fi between this machine and the speaker
  had trouble, while nothing the server measured could see it: the kernel's send buffer hides a stall from the writer.
  The server now reads the retransmission, timeout and round-trip counters of the connection each speaker fetches
  audio over, on Windows and Linux, into the pipeline snapshot and the end-of-stream summary, warns when data had to be
  resent, and judges the link good, degraded or poor over the last minute, logging each change. The verdict is kept
  for the speaker monitor, which counts a poor link as a cause when a speaker's head start runs out; it is not sent to
  clients, since link trouble the head start rides out needs no telling, and the stream's jitter buffer does nothing
  for this link anyway.

- [#223](https://github.com/brew-lab/thaumic-cast/pull/223) [`2bc2375`](https://github.com/brew-lab/thaumic-cast/commit/2bc2375e7255f4234df9caed0281a620186b2c86) Thanks [@skezo](https://github.com/skezo)! - refactor(core): every speaker monitor log line now starts with [SpeakerMonitor]

  The speaker monitor wrote some log lines under `[SpeakerMonitor]` and others under the old name `[LatencyMonitor]`,
  so one grep did not find them all. The 27 lines below now start with `[SpeakerMonitor]`. Only the tag changed: the
  rest of each line, its level and when it is written are the same. A grep, filter or alert on `[LatencyMonitor]`
  needs to look for `[SpeakerMonitor]` instead. No other tag was renamed.

  From `services/speaker_monitor/monitor.rs`:
  - `Busy; topology change for {} not added to its timeline`
  - `Invalid speaker IP: {}`
  - `Background task started`
  - `Shutting down`
  - `Video sync requested before the speaker's first fetch: stream={}, speaker={}`
  - `Stopped monitoring: stream={}, speaker={}`
  - `Stopped all monitoring for stream={}`
  - `No valid position for {}s: stream={}, speaker={}, epoch={}`
  - `{}: GENA transport state stale; using polled state`
  - `Ended monitoring ({}): stream={}, speaker={}`
  - `Connection registered: stream={}, speaker={}, epoch=#{}, {}`
  - `speaker={}: {} position polls in a row failed ({}); polling every {}s until it answers`
  - `Failed to get position from {}: {}`
  - `speaker={}: answering position polls again after {} failures`
  - `Failed to get transport state from {}: {}`
  - `stream={}, speaker={}: playing something else ({}); not polling it until it fetches the stream again`
  - `Waiting for stream {} (current URI: {})`
  - `URI matched: {} contains {}`
  - `poll stream={}, speaker={}: rel={}ms rtt={}ms delivered=...`
  - `speaker={}: {} ({}), poll not measured`
  - `stream={}, speaker={}: latency={}ms, jitter={}ms, confidence={}`

  From `services/speaker_monitor/session.rs`:
  - `Epoch changed {} -> {}, resetting (seeding with {}ms)`

  From `services/speaker_monitor/session/video_sync.rs`:
  - `Track restart: reltime {} -> {}, maintaining ~{}ms latency (offset={}ms)`
  - `stream={}ms, sonos={}ms (continuous={}ms, offset={}ms), latency={}ms`
  - `stream={}, speaker={}: cushion nearly exhausted ({}ms of audio ahead of the playhead); ...`
  - `stream={}, speaker={}: cushion={}ms (last {}ms, ...), trend {}, rtt={}ms`
  - `stream={}, speaker={}: cushion shrinking ...ms/min; at this rate the speaker runs dry in ~{} min. ...`

- [#217](https://github.com/brew-lab/thaumic-cast/pull/217) [`46e2827`](https://github.com/brew-lab/thaumic-cast/commit/46e28275dbebda627eeb03846a00a4767396358f) Thanks [@skezo](https://github.com/skezo)! - refactor(core,server): move the speaker monitor loop into its module and name it SpeakerMonitor

  An internal restructuring with no behaviour change. The polling loop that watches speakers lived in
  `services/latency_monitor.rs` under the name `LatencyMonitor`, apart from the rest of the speaker monitor. It is now
  `services/speaker_monitor/monitor.rs` and the type is `SpeakerMonitor`. Settings, environment variables, events and
  the text of every log line are the same.

  One thing differs in the logs: lines emitted from this file now print the module path
  `thaumic_core::services::speaker_monitor::monitor` instead of `thaumic_core::services::latency_monitor`. A grep or a
  log-level filter on the module path needs updating; a grep on `[SpeakerMonitor]` does not.

- [#218](https://github.com/brew-lab/thaumic-cast/pull/218) [`e4da69d`](https://github.com/brew-lab/thaumic-cast/commit/e4da69d51337f23becc459e03fdc267a1cf66fb0) Thanks [@skezo](https://github.com/skezo)! - refactor(core): split the speaker monitor's loop from the per-speaker session it keeps

  An internal restructuring with no behaviour change. `services/speaker_monitor/monitor.rs` held both the polling loop
  and everything the loop keeps about each speaker. The loop stays there; the per-speaker session moves to `session.rs`,
  and its parts to `session/video_sync.rs`, `session/report.rs`, `session/drift.rs` and `session/health.rs`. Code moved
  as it was: settings, environment variables, events and the text of every log line are the same.

  One thing differs in the logs, again: a line prints the module path of the file it is now in. Lines that printed
  `thaumic_core::services::speaker_monitor::monitor` now print that or one of
  `thaumic_core::services::speaker_monitor::session`, `...::session::video_sync`, `...::session::report`,
  `...::session::drift` and `...::session::health`. The 30 s report line, for one, now comes from
  `...::session::report`. A grep or a log-level filter on the module path needs updating; a grep on `[SpeakerMonitor]`
  does not.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`37ebc3a`](https://github.com/brew-lab/thaumic-cast/commit/37ebc3a4d7b451197adad3be41f29d763291ccf1) Thanks [@skezo](https://github.com/skezo)! - feat(core): keep an eye on every speaker that fetches a stream, with a setting to turn it off

  Speakers were only asked for their playback position when a client wanted video sync, so a speaker slowly running out
  of audio during an ordinary cast left nothing in the log until it could be heard. Monitoring now follows the stream
  itself: whichever speaker actually fetches the audio is polled with a quiet GetPositionInfo every two to three
  seconds, however the cast was started, and never more than 120 times a minute across the whole server. Grouped
  speakers and home-theatre satellites, which never fetch, are never polled. A speaker that reports another track is
  left alone until it fetches the stream again, a poll taken while it is known to be paused is not counted, and GENA's
  transport state is only believed once it has been heard since the speaker was first watched, with GetTransportInfo
  every 30 seconds standing in when it has not. Monitoring is on by default. It can be switched off in the desktop
  Settings view, with `speaker_monitor: false` in the server's config.yaml, or with `THAUMIC_SPEAKER_MONITOR=off`, which
  restores the old behaviour of polling only video-sync casts; video sync works either way, and a change applies from
  each speaker's next connection.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`6ed39cd`](https://github.com/brew-lab/thaumic-cast/commit/6ed39cd3c0ae72678b56fa1a2f72ee650d650674) Thanks [@skezo](https://github.com/skezo)! - feat(protocol): describe speaker notices and the companion's audio settings

  The protocol now describes what the companion decided to tell a user about a speaker: the speakerHealth event
  carries an optional `notice` (its kind, `noticeId`, the stall, what was left, the head start sent and suggested, the
  minutes to running low, and whether a restart refills the speaker), beside the head start sent and configured, the
  floor, the stall and the time to the floor. A notice this build cannot read is dropped rather than failing the whole
  report. Two stream events are added: `ingestGaps`, when audio from the browser reached the companion late often enough
  to give every speaker a gap, with the smoothing step that would have covered it, and `companionAudioChanged`, with the
  speaker head start (0 to 2000 ms), whether an environment variable fixes it, and whether the speaker monitor is on.
  The companion also sends those settings in `INITIAL_STATE` as `companionAudio`, so a client can show the head start
  and word its notices from the moment it connects; an older companion leaves it out, and malformed settings degrade to
  absent instead of failing the snapshot.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`386d633`](https://github.com/brew-lab/thaumic-cast/commit/386d633180038c77fafaad514545ffce48a0fd49) Thanks [@skezo](https://github.com/skezo)! - feat(core): decide speaker notices in the core and drop the jitter-buffer suggestion

  The server told clients about every change in a speaker link's quality and suggested a larger jitter buffer, which
  cannot help: the jitter buffer only evens out how audio reaches this machine, not how it reaches the speaker. That
  event and its suggestion are gone. Instead the speaker monitor decides, at each 30-second report, whether there is
  anything to tell the user about a speaker, and the speakerHealth event carries it as `notice`: the speaker head start
  ran out (it cut out, and a Wi-Fi stall or a poor link caused it), came close, or ran out when no length would have
  been enough; the reserve itself is running low; or the speaker's clock is draining it with less than half an hour to
  go. Head-start notices suggest the smallest of 250, 500, 750, 1000, 1500 and 2000 ms above the current setting that
  would have covered the stall, and stand for the rest of the cast unless the speaker reconnects with a longer head
  start. Each episode keeps its `noticeId` while it is repeated, so a client can dismiss
  it once, and gets a new one only on a new episode or an escalation; the same kind starts a new episode at most once
  every ten minutes, and advice to restart the cast is only given when a restart would refill the speaker. Separately,
  a PCM stream whose smoothing runs dry twice in a minute, which gives every speaker a gap at once, raises an
  ingestGaps stream event for its owner, at most once every ten minutes, with the smoothing step that would have
  covered the worst gap, or none when no step would. A companionAudioChanged event tells every client the speaker head
  start and speaker monitor setting whenever they change; the desktop app sends it when speaker monitoring or the head
  start is changed.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`637d324`](https://github.com/brew-lab/thaumic-cast/commit/637d324ae23cfb9b2c0d34ed5c724a681fbccebc) Thanks [@skezo](https://github.com/skezo)! - fix(core): send each speaker position poll at its dithered moment

  The monitor wakes every 500 ms and sent a due poll on the wake-up that noticed it, so every poll landed on that grid and
  hit one of two points in the speaker's whole-second position. The random spacing was lost, and the reserve estimate
  stalled at about half a second wide instead of narrowing to a few tens of milliseconds, so it never locked. A poll now
  waits out the rest of its interval and goes at its own moment.

  The dither itself is now a random draw per speaker. It used to be read from the wall clock at the wake-up that sent the
  poll, which on the 500 ms wake-up grid took only two values fixed by when the process started, so for some start times
  the polls still piled onto a few points in the speaker's second. Each `[SpeakerMonitor]` line now also reports its poll
  count and `phase_gap`, the widest stretch of the second its polls left unsampled.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`1c3a1d9`](https://github.com/brew-lab/thaumic-cast/commit/1c3a1d9b36abfd500c39e87b8c432cb39dd083bb) Thanks [@skezo](https://github.com/skezo)! - refactor(core): poll speakers in isolated tasks with quiet SOAP

  The latency monitor polled every speaker's position in turn from one loop and waited on each answer, so a speaker
  that stopped responding held up every other speaker's polls, and the video-sync measurements with them, for up to the
  full ten-second SOAP timeout per attempt. Each poll now runs in its own task and is abandoned after 1.5 s; a speaker is
  never polled again while its previous poll is outstanding, and after three failed polls in a row it is asked only every
  five seconds until it answers. Position polls also log their per-call SOAP lines at debug instead of info, so a long
  cast no longer fills the log with them. What is measured and when a speaker is polled are otherwise unchanged.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`97198d3`](https://github.com/brew-lab/thaumic-cast/commit/97198d322103e7a75e8ea17a3bf52be5bd473b86) Thanks [@skezo](https://github.com/skezo)! - feat(core): estimate speaker reserve and clock rate from RelTime bounds

  The old cushion figure subtracted the speaker's whole-second RelTime from wall-clock time since the epoch, so it
  counted our own cadence queue as audio the speaker held and jittered by several hundred milliseconds between polls: a
  reading of 200 ms could mean the speaker was already empty. Each poll of a PCM connection now bounds the speaker's
  true reserve, audio delivered minus audio played, to within a second, and the last three minutes of dithered polls
  narrow that to a few tens of milliseconds, trimmed against stray answers and widened by a learnt allowance for RelTime
  tick jitter. The speaker's clock rate against ours is fitted from its playhead alone, so audio inserted later to
  compensate cannot bias it, and jointly over every stretch of unbroken playback, so a speaker that refetches the stream
  every few minutes still gets an honest error. Every 30 seconds one `[SpeakerMonitor]` line per speaker reports the
  reserve, the clock rate, a drain projection, poll rate, jitter, the cadence queue, delivery gaps and retransmissions;
  a speaker whose reserve is draining (see the reserve floor entry) is warned about once and shown as `state=draining`,
  and a jump in the reserve that looks like an underrun is warned about too. Each connection ends with a summary line,
  and the pipeline timeline carries the reserve and clock too. The wall-clock cushion line remains only for compressed
  codecs, whose byte counts say nothing exact about playback time.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`b5c254b`](https://github.com/brew-lab/thaumic-cast/commit/b5c254b0c25b233a820ff29f2c9b60203e6f1b22) Thanks [@skezo](https://github.com/skezo)! - feat(core): judge a low speaker against a floor sized from its head start

  The low-reserve alarm compared a speaker's acknowledged reserve with the level it settled at, so a speaker that
  settled at 500 ms and dipped to 350 ms was called low, while one that started a cast with the speaker head start off
  and next to nothing in hand never was. A speaker is now low when its acknowledged reserve's 10th percentile over a
  30-second window falls below an absolute floor sized from the head start its connection was actually sent
  (clamp(0.3 x head start, 40, 150) ms: 150 ms at the default 500 ms, 40 ms with the head start off), and it recovers
  once it regains the floor plus clamp(0.2 x head start, 30, 100) ms. Each connection records the head start it was sent
  beside the one configured, which differ when the stream held too little audio when the speaker connected. The drain
  projection is now a time to that floor rather than to empty, at the clock rate shrunk by its uncertainty so a rate
  pooled from a few short segments cannot put a speaker hours from the floor inside the warning window, and a speaker is
  reported draining when that is under 30 minutes. Acknowledgement lag is also sampled on every monitor tick, so a stall
  long enough to stop the connection's own snapshots is still seen, and each window reports its stall: the worst lag
  less the median, which leaves out what is steadily in flight. The level a connection settles at is now learned per
  connection, from its first two tight estimates, and logged against its head start as `calib`; the acknowledged
  reserve from before a segment break is kept for judging what led up to it. Each `[SpeakerMonitor]` line reports
  `H=`, `Hcfg=`, `floor=`, `clear=`, `stall=`, `ttf=`, `calib=`, `link=` and how far the reserve has `dropped=`, and the
  speakerHealth event carries the head start sent and configured, the floor, the stall and the time to the floor in
  place of the time to empty.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`e54f202`](https://github.com/brew-lab/thaumic-cast/commit/e54f202bed6a967bfd2a43d5a099743c1f00eb13) Thanks [@skezo](https://github.com/skezo)! - fix(core): keep a locked speaker reserve locked through ordinary widening

  A speaker's reserve estimate locked and unlocked on the same test, so a few lost polls or an unlucky spread of poll
  phases widened it past about 110 ms and dropped the lock, and the monitor went back to `state=locking` on a speaker
  that was fine. The lock is now strict to acquire and loose to hold: once locked, an estimate stays locked up to 200 ms
  wide while its window holds at least 30 polls, and the lock drops only after two estimates in a row fail that, or at
  once on a segment break. Only estimates as narrow as acquiring needs set the underrun-step baseline and the level the
  low-reserve alarm is measured from, and the step threshold never counts more width than acquiring allows, so a held
  estimate cannot hide a real underrun. Each `[SpeakerMonitor]` line reports `lock=` (acquired, tight, held or
  unlocked), and the monitor warns once when so many speakers share its poll budget that none of them can hold a lock.

- [#219](https://github.com/brew-lab/thaumic-cast/pull/219) [`d15bef4`](https://github.com/brew-lab/thaumic-cast/commit/d15bef4865d56c34f7f01e74771cb964e440a164) Thanks [@skezo](https://github.com/skezo)! - Internal restructuring with no behaviour change: the per-connection delivery tracking that every codec uses (the connection guard, the first-connection wait, the epoch hook and the pipeline snapshot types) moved out of `stream/cadence.rs` into a new `stream/delivery.rs`, leaving the PCM cadence on its own. The connection and first-wait log lines now print the module path `thaumic_core::stream::delivery` instead of `thaumic_core::stream::cadence`; the `[Stream]` and other prefixes inside the messages are unchanged.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`f760cf6`](https://github.com/brew-lab/thaumic-cast/commit/f760cf667b511e5bae7458d8eeb9875920fb9659) Thanks [@skezo](https://github.com/skezo)! - fix(core): advertise the speakers' LAN address from the first discovery

  At launch nothing has been discovered, so the advertised address is chosen from the interface list alone, and on a
  machine whose default route runs through a VPN adapter the name filter does not recognise (Cloudflare WARP on Windows)
  it is the tunnel's. Detection only ran again at the top of the next refresh, so the first round of GENA subscriptions,
  and any cast started in the meantime, were built on an address no speaker could reach. Detection now re-runs against
  the speakers as soon as discovery finds them, before the groups are published or anything is subscribed. Playback
  also moves the address onto the target speakers' subnet when it is on none of them and a detected address is, and a
  SUBSCRIBE rejected with 412 is retried once with a corrected callback. An explicitly configured address is never
  changed, and with no speakers known the launch choice is unchanged.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`602c9ee`](https://github.com/brew-lab/thaumic-cast/commit/602c9ee2ff71b41f4added085bda4a48c1d1154c) Thanks [@skezo](https://github.com/skezo)! - fix(desktop): show how many machines a stop-all affects

  Stopping all streams from the tray ends casts for every connected browser, including ones on other machines, and said
  nothing about it. The connection manager now reports distinct remote machines with their connections and streams, so a
  browser holding several sockets counts once, and the action warns when more than this machine is affected. A browser
  on the same machine reached through its network address is treated as local, so a single user still gets one quiet
  click.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`c03dd07`](https://github.com/brew-lab/thaumic-cast/commit/c03dd07d58fd689b5df36a5bd3f8d383dcaf34c1) Thanks [@skezo](https://github.com/skezo)! - feat(core): serve an audio stream only to the speakers it is for

  A stream identifier is not private. The server gives the stream address to the speaker, and the speaker reports it to
  anything on the network that asks, which this codebase does itself when reading what a speaker is playing. Each
  request now works out which addresses that stream is for, from the sessions it actually has plus the machine running
  the server, and compares them consistently so an address written in either form still matches. Working this out per
  request rather than recording one address covers speakers joining, leaving, being taken over and being promoted, which
  matters because an unsynchronised cast has every speaker fetching separately.

  This ships observing rather than enforcing. The `strict_stream_access` option defaults to off, so every request is
  served exactly as before and unexpected addresses are logged with the stream and the addresses that were expected.
  Turn it on once the logs from a real setup show nothing unexpected, because a wrongly refused request is silence with
  nothing to see. Only the headless server exposes the option; the desktop app keeps the default. Refused requests answer
  not-found, the same as an expired stream. A separate limit bounds simultaneous readers that are not on the list, since
  each one starts its own pipeline; speakers the stream is for are never counted against it, and readers that are not
  speakers are kept out of the per-speaker playback tracking so they cannot disturb a real speaker's reconnects. One
  known gap once enforced: a speaker whose address changes mid-cast is refused until playback is restarted.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`602c9ee`](https://github.com/brew-lab/thaumic-cast/commit/602c9ee2ff71b41f4added085bda4a48c1d1154c) Thanks [@skezo](https://github.com/skezo)! - fix(core): remove a stutter at stream start and stop removed streams lingering

  Frames were added to the buffer and broadcast in two steps, so a speaker connecting in between received the newest
  buffered frame twice and stuttered as playback began. The send now happens with the buffer, so the two cannot
  interleave. Separately, the HTTP response held the stream strongly, so a removed stream kept its channel alive and
  kept emitting silence until the speaker disconnected, leaking the connection entirely if the stop request failed.
  The response now holds the stream weakly and ends when it is gone.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`602c9ee`](https://github.com/brew-lab/thaumic-cast/commit/602c9ee2ff71b41f4added085bda4a48c1d1154c) Thanks [@skezo](https://github.com/skezo)! - feat(protocol): say when another client takes a speaker, and show speakers in use

  Taking a speaker from another client sent a stop with no reason, so the other person saw a generic message. A distinct
  reason is now sent and shown. The extension also never read the session list the server provides, so availability came
  only from that browser's own casts and the automatic choice was always the first group alphabetically, meaning several
  machines defaulted to the same speaker and each showed it as free. Speakers in use by another client are now a
  separate state, skipped when choosing automatically and still selectable deliberately, and the concurrent stream count
  comes from the server rather than one browser's view.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`d431658`](https://github.com/brew-lab/thaumic-cast/commit/d431658c04d5d66ca4c6106ec762129e29d14551) Thanks [@skezo](https://github.com/skezo)! - feat(core): diff zone topology and report satellite and radio changes

  A home-theatre satellite dropping off, a device rebooting or a radio changing channel could explain a stutter the
  speaker's buffer does not, but the topology log only ever said "N group(s)", because satellites were folded into their
  room. Each GetZoneGroupState answer is now also read as a household that keeps satellites under their primary, zone
  bridges, BootSeq, the radio fields and the vanished devices, and compared with the previous answer. A satellite still
  in the channel map but no longer listed is reported missing, and returned (with how long it was gone) when it comes
  back; reboots, radio changes, newly vanished devices and group joins and leaves are reported too. Each change is
  logged, at warn when it points at trouble and with the stream when a speaker it concerns is casting, sent to clients
  as a memberChanged topology event, and listed on the next speaker monitor line for that speaker, whose connection
  summary counts them. The first answer reports satellites already missing. GENA bodies are never compared, since they
  can be stale; their log line now describes the household's shape instead of counting groups.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`602c9ee`](https://github.com/brew-lab/thaumic-cast/commit/602c9ee2ff71b41f4added085bda4a48c1d1154c) Thanks [@skezo](https://github.com/skezo)! - fix(core): reconcile subscriptions on every topology refresh

  The quick refresh replaced only the group snapshot and reset the periodic timer, so a speaker promoted to coordinator
  could go a full interval or longer without an event subscription, leaving its transport state stale. A burst of
  topology events could also defer the full refresh indefinitely. Both paths now share one reconciliation step and the
  quick path no longer resets the timer.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`a8b9c7e`](https://github.com/brew-lab/thaumic-cast/commit/a8b9c7eb726234e71a5f58888d05e0fd051b106d) Thanks [@skezo](https://github.com/skezo)! - fix(core): recover when a VPN connects or disconnects

  Address detection followed the default route, so a full-tunnel VPN made the server advertise the tunnel address while
  speaker discovery, which already skips virtual interfaces, still found speakers on the real network. Every callback,
  stream and artwork address then named somewhere no speaker could reach. Detection now applies the same interface
  filter, prefers an address sharing a subnet with a known speaker, and ranks private ranges so a container or
  virtualisation bridge no longer wins. The network advertisement is re-registered when the address changes rather than
  fixed at startup.

  Recovery previously needed a restart because a subscription made against the wrong address renews indefinitely: the
  renewal carries only the subscription identifier, needs no inbound reachability, and prevents its own replacement.
  Each refresh now compares a subscription's recorded callback against the current one and rebuilds only those that
  differ.

  Detection is deliberately strict so a momentary loss is not mistaken for a network change, but the desktop falls back
  to the default route at startup, so a machine whose only address sits on a filtered adapter still launches. The
  headless server stays strict and continues to advise setting an explicit advertise address.

  Relates to [#112](https://github.com/brew-lab/thaumic-cast/issues/112)

- [#187](https://github.com/brew-lab/thaumic-cast/pull/187) [`a0819ed`](https://github.com/brew-lab/thaumic-cast/commit/a0819ed6b51d2a833538858ba85154c4a3073ef9) Thanks [@skezo](https://github.com/skezo)! - fix(core): never advertise the Cloudflare WARP address at launch

  With Cloudflare WARP connected on Windows, the desktop app started up advertising WARP's tunnel address
  (100.96.x.x) and corrected it to the LAN address only once the first discovery found the speakers, about 5 s
  later. Nothing was cast in that window, but the address was announced over mDNS and shown on the Server
  page, the log warned "Local IP changed" on every launch, and discovery tried to broadcast on the WARP adapter
  every 30 s and logged three failures each time.
  - WARP's adapter (`CloudflareWARP`) is now filtered like other VPN adapters, for address choice and for
    discovery.
  - An address in 100.64.0.0/10, the range WARP and Tailscale give their adapters, no longer wins just because it
    owns the default route, so a VPN under an adapter name we do not know is passed over too. A machine whose only
    address is in that range still advertises it.

- [#187](https://github.com/brew-lab/thaumic-cast/pull/187) [`e8a18dc`](https://github.com/brew-lab/thaumic-cast/commit/e8a18dc1362f244597ca7b7acab28233acbfd76c) Thanks [@skezo](https://github.com/skezo)! - docs(core): describe the 0xFFFFFFFF WAV header as a 4 GiB length

  The 0xFFFFFFFF in both WAV header size fields of a PCM stream was documented as the conventional marker for an
  unbounded stream. A Playbar (S2 86.10) treats it as a length: a chunked cast stopped at exactly 2^32 bytes, 6h12m50s at
  48 kHz stereo, with the speaker hanging up and going to STOPPED with no reconnect and no `Range` request. The code
  comments, the server README and the architecture notes now say so, and that a cast goes on past it only through PCM
  segment continuation, which follows in this series.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`921110c`](https://github.com/brew-lab/thaumic-cast/commit/921110c2c05b2d2af9689de4d10279848e4d538d) Thanks [@skezo](https://github.com/skezo)! - fix(core): keep speaker commands from interrupting audio

  Volume, mute, query and playback commands were handled in the same place incoming audio is read, so a slow or
  unreachable speaker stalled the stream for as long as its requests took, well beyond the buffer. Commands now run on a
  separate worker per connection with replies passed back in order, leaving audio to flow while they complete.

## 0.11.0

### Minor Changes

- [#101](https://github.com/brew-lab/thaumic-cast/pull/101) [`b7776d3`](https://github.com/brew-lab/thaumic-cast/commit/b7776d33e513c1c82be4388829e8f725e3cb03e3) Thanks [@skezo](https://github.com/skezo)! - Add core-side pipeline instrumentation timeline for post-session diagnostics

  `LoggingStreamGuard` now accumulates per-tick pipeline snapshots (receive jitter from `StreamState`, cadence buffer health, HTTP delivery stats) and serializes them alongside the existing stream summary on drop. Snapshots land in a `Mutex`-guarded buffer so a mid-loop cadence abort (typical when Sonos closes HTTP) preserves the timeline instead of losing it.

  The cadence stream holds `Weak<StreamState>` rather than `Arc` so instrumentation does not prolong stream lifetime after cleanup; snapshots are skipped when the upgrade fails.

  Complements the extension-side metric timeline already shipped with the MSTP worker infrastructure — the two halves now cover all six pipeline stages end-to-end.

- [#103](https://github.com/brew-lab/thaumic-cast/pull/103) [`153a447`](https://github.com/brew-lab/thaumic-cast/commit/153a44754061c3d57d101d227d4654a863f201d9) Thanks [@skezo](https://github.com/skezo)! - Exchange companion version metadata over the existing connection so the extension can warn users when their desktop app or server is out of date.
  - `/health` now reports `appType` alongside the existing service identifier and stream limit. The extension reads it at discovery time so it knows which companion it's talking to before the WebSocket even connects.
  - The WebSocket `INITIAL_STATE` payload — sent on every connect, including the always-on control connection — now carries `appType`, `appVersion`, and `protocolVersion`. The extension persists these into the existing `connectionState` store; there is no separate companion-info storage.
  - `thaumic-core` exposes a new `AppInfo` / `AppType` pair passed to `AppState::new`. `apps/desktop` and `apps/server` each thread their own `env!("CARGO_PKG_VERSION")` through.
  - The extension compares the reported `protocolVersion` against `MIN_COMPATIBLE_PROTOCOL_VERSION` on every connect:
    - Renders a dismissible warning Alert in the popup with an "Update Desktop App" / "Update Server" / "Update" action button (chosen from `appType`) deep-linking to the GitHub releases page.
    - Renders a persistent inline "Update available" link in the popup footer and in the options About section, even after the Alert has been dismissed, so the user always has a path to the releases page.
    - Dismissal is keyed by `appVersion` (or `null` for pre-0.4.0 companions) in `chrome.storage.local`, so rolling forward — including from "unknown" to a real version — re-arms the warning.
  - The popup footer copy is type-aware: "Connected to Desktop App", "Connected to Server", or just "Connected" when the type is unknown.
  - Older companions that omit the new fields are treated as out-of-date (not "assume compatible"), since the extension may have been auto-updated by Chrome ahead of the user updating the companion. The Alert and footer link still appear; copy degrades gracefully ("Your app predates this extension and can't report its version").
  - Shared UI: new `link` variant on `<Button>` for inline text-link CTAs.

  No new remote calls are introduced — the check runs entirely off discovery and the existing WebSocket, preserving the privacy promise in PRIVACY.md.

- [#72](https://github.com/brew-lab/thaumic-cast/pull/72) [`c0c6033`](https://github.com/brew-lab/thaumic-cast/commit/c0c60339b4a5d75168296d1ff6e53ad51b97f422) Thanks [@skezo](https://github.com/skezo)! - Add synchronized multi-speaker playback using Sonos x-rincon protocol

  When streaming to multiple Sonos speakers, audio now plays in perfect sync by using Sonos's native group coordination mechanism instead of sending independent streams to each speaker.

  **How it works:**
  - One speaker becomes the "coordinator" and receives the actual stream URL
  - Other speakers become "slaves" that join the coordinator via `x-rincon:{uuid}` protocol
  - Slaves sync their playback timing to the coordinator, eliminating drift

  **Changes:**
  - Add `join_group()` and `leave_group()` SOAP commands to sonos client
  - Extend `SonosPlayback` trait with group coordination methods
  - Add `GroupRole` enum (Coordinator/Slave) to track speaker roles
  - Update `PlaybackSession` with role, coordinator_ip, and coordinator_uuid fields
  - Implement coordinator selection (prefers existing Sonos group coordinators)
  - Refactor `start_playback_multi` to use synchronized group playback
  - Add group-aware cleanup in stop methods (slaves unjoin, coordinator cascade)
  - Fix `get_expected_stream` to handle x-rincon URIs correctly for slaves
  - Add `get_member_uuid_by_ip` helper for UUID lookup across all group members

  **Behavior:**
  - Single speaker: unchanged (no grouping)
  - Multiple speakers: synchronized via x-rincon protocol
  - Fallback: independent playback if UUID lookup fails
  - User's existing Sonos groups are restored after streaming ends (best-effort)

- [#90](https://github.com/brew-lab/thaumic-cast/pull/90) [`facd9e8`](https://github.com/brew-lab/thaumic-cast/commit/facd9e8d5814807947193c2fd8e80b566223bb38) Thanks [@skezo](https://github.com/skezo)! - Add WASAPI process-specific loopback capture for browser-wide audio streaming on Windows

  Instead of capturing audio per-tab via the Chrome `tabCapture` API, this adds an alternative mode that captures all audio from the browser process at the OS level using Windows Audio Session API (WASAPI) process loopback. Requires Windows 10 build 20348+.

  **New packages:**
  - `thaumic-capture` crate: platform-gated WASAPI capture library with `WasapiSource`, browser PID discovery via `CreateToolhelp32Snapshot`, and COM/MMCSS-elevated capture thread
  - `wasapi-capture` CLI: diagnostic tool that captures N seconds of audio from a PID, outputs Float32 WAV + timing stats for validation

  **Core (`thaumic-core`):**
  - `capture` module with platform-agnostic `AudioSource`/`AudioSink`/`CaptureHandle` traits and `CaptureSourceFactory` factory pattern (avoids cyclic dependency with `thaumic-capture`)
  - `StreamSinkBridge` converts Float32 → PCM16 on the capture thread and pushes into existing `StreamRegistry` pipeline
  - `StreamCoordinator::start_capture_stream()` wires up the full capture → stream path
  - WebSocket handler adds `START_BROWSER_CAPTURE`, `STOP_BROWSER_CAPTURE`, and async `BROWSER_CAPTURE_ERROR` monitoring (process exit, device disconnect)

  **Desktop app:**
  - `WasapiCaptureFactory` bridges `thaumic-capture` into core's factory trait
  - `get_capture_capabilities` Tauri command exposes platform availability to frontend

  **Extension:**
  - New `captureMode` setting (`tab` | `browser`) with UI toggle in Advanced Settings
  - Mode exclusivity enforcement (tab and browser capture cannot coexist)
  - Browser capture flow: sends `START_BROWSER_CAPTURE` over WebSocket, server handles capture — no offscreen AudioWorklet needed
  - `StreamSession` refactored to handle both capture modes with appropriate teardown
  - `BROWSER_CAPTURE_ERROR` handling for graceful recovery on capture failures

  **Protocol:**
  - `BROWSER_CAPTURE_ERROR` message type with Zod schemas added to WebSocket protocol

### Patch Changes

- [#106](https://github.com/brew-lab/thaumic-cast/pull/106) [`d659f5e`](https://github.com/brew-lab/thaumic-cast/commit/d659f5e6ed12f7f701d5c8cb6601d654ab2c7053) Thanks [@skezo](https://github.com/skezo)! - Tighten the PCM jitter-buffer pipeline and add cadence startup diagnostics.
  - Prefill frames returned by `subscribe()` are trimmed to the intended buffer depth (`jitter_buffer_ms / frame_duration_ms`) before being queued, keeping the newest frames. Previously a resume with a populated ring buffer could replay up to a full second of stale audio before catching up to live.
  - The cadence queue's drop threshold is now `buffer_depth × JITTER_OVERFLOW_MULTIPLIER` (3) instead of a single `queue_size` value, so short producer bursts (e.g. Chrome scheduling gaps dumping backed-up frames) don't drop frames immediately. Steady-state queue depth is unchanged.
  - Introduces `CadenceConfig::new(silence, jitter_buffer_ms, frame_ms, format, prefill)` as the canonical construction path; it computes `overflow_cap` and trims prefill in one place instead of duplicating the math in `api/stream.rs`.
  - Adds two startup diagnostic logs — `[Cadence] Startup: prefill_frames=…` and `[Cadence] First yield: {audio|silence}` — so field logs can show whether fresh casts begin with audio or silence, independent of downstream behavior.

  Startup buffering and underrun recovery behavior match pre-PR: the pre-subscribe sleep honors the user-configured `jitter_buffer_ms` (skipped on resume), and the cadence loop emits silence on underrun and resumes as soon as a frame is available.

- [#81](https://github.com/brew-lab/thaumic-cast/pull/81) [`77a19e2`](https://github.com/brew-lab/thaumic-cast/commit/77a19e21150e6b7cd35af44fb3bd6d47edc4d636) Thanks [@skezo](https://github.com/skezo)! - Refactor core internals, remove dead code, and improve multi-speaker performance

  **Refactoring:**
  - Decompose `StreamCoordinator` into focused modules: `PlaybackSessionStore`, `SyncGroupManager`, `VolumeRouter`
  - Decompose Sonos client into focused modules: `didl`, `grouping`, `playback`, `retry`, `subscription_arbiter`, `volume`, `zone_groups`
  - Extract cadence streaming pipeline from `http.rs` into `stream/cadence.rs`
  - Extract stream_audio handler, StartPlayback handler, and parse_stream_config from WS handshake into focused modules
  - Extract helpers: `CleanupOrder`, `CrossfadeState`, `with_epoch_tracking` combinator, `teardown_speaker`, `ensure_playing`
  - Replace `SoapRequestBuilder` with `soap_request` function
  - Replace `AppStateBuilder` with `AppState::new` constructor
  - Rename `StreamManager` to `StreamRegistry`
  - Remove `TaggedFrame` enum, inline epoch tracking
  - Merge `gena_event_builder` into `gena_parser`
  - Move NOTIFY service routing from subscription manager to event processor
  - Deduplicate `BroadcastEventBridge` emit methods with macro
  - Deduplicate `cleanup_stream_if_no_sessions` into `SyncGroupManager`
  - Remove redundant `stream_coordinator` field from `GenaEventProcessor`
  - Remove redundant `broadcast_tx` from `AppState`
  - Unify sync vs non-sync start path in `StreamCoordinator`
  - Normalize `SonosEvent` imports to canonical events path
  - Deduplicate retry logic, tighten module visibility, clean up logs

  **Dead code removal:**
  - Remove unused traits: `Transcoder`/`Passthrough`, `Lifecycle`, `TaskSpawner`, `CoreState`
  - Remove unused implementations: `NoopEventEmitter`, `LoggingEventEmitter`
  - Remove unused methods: `UrlBuilder::websocket_url`, `StreamingRuntime::handle`, `BroadcastEventBridge::clear_external_emitter`, `SonosClientImpl::with_discovery_config`
  - Remove dead `ErrorCode` impls for `SoapError` and `GenaError`, 3 dead error variants, dead discovery error variants
  - Remove dead fields: `DeviceInfo.model_number`, `PlaybackEpoch` telemetry and dead fields, `PositionInfo` dead fields, `StreamMetadata` album/artwork fields, 9 dead `Config` fields
  - Remove dead `raise_process_priority` function

  **Performance:**
  - Parallelize sequential SOAP calls across multi-room playback
  - Gate server-side latency monitoring behind client `videoSyncEnabled` opt-in to avoid unnecessary overhead
  - Make delivery tracking lock-free

  **Fixes:**
  - Fix stale `sync_ips` cleanup when speakers leave a session
  - Fix stale log prefixes and correct module visibility
  - Pass `preferred_port` to `NetworkContext` in `bootstrap_services`
  - Add 1ms timeout to test HTTP clients to avoid TCP SYN hangs

  **Protocol:**
  - Add `videoSyncEnabled` boolean field to `WsStartPlaybackPayload` (defaults to `false`, backward compatible)

- [#99](https://github.com/brew-lab/thaumic-cast/pull/99) [`a097322`](https://github.com/brew-lab/thaumic-cast/commit/a0973226e77f104d87544597483c74ef260b3e66) Thanks [@skezo](https://github.com/skezo)! - Harden streaming network path and diagnostic log retention

  Four isolated fixes to the local streaming daemon and desktop app:

  **Core (`thaumic-core`):**
  - TCP_NODELAY on all accepted connections disables Nagle's algorithm so small PCM frames (1920 bytes) ship immediately instead of being batched, reducing delivery jitter to Sonos.
  - TCP keepalive on accepted connections (10s idle, 5s interval, 3 retries on Linux) detects stalled speakers within ~25s instead of the default ~2 hours, preventing async tasks from being held alive on dead connections.
  - SSDP discovery now skips link-local (`169.254.0.0/16`) addresses that cause bind failures on adapters like Bluetooth with no real connectivity, and expands the virtual-interface prefix list (Windows `vEthernet`, WireGuard, Tailscale, ZeroTier) that cannot reach local Sonos speakers.

  **Desktop:**
  - Raises log max file size to 1 MB so pipeline diagnostic dumps survive across sessions without rotation.

- [#105](https://github.com/brew-lab/thaumic-cast/pull/105) [`32ae247`](https://github.com/brew-lab/thaumic-cast/commit/32ae2471d81ace318b32080badceb578b8019ae5) Thanks [@skezo](https://github.com/skezo)! - Rename `streamingBufferMs` setting to `jitterBufferMs` across the stack

  Pure rename — no behavior change. Every value, default, clamp range, and UI option stays the same. Identifier updated on the protocol, core, extension, and desktop surfaces, plus docstrings and the one user-facing label ("Streaming Buffer" → "Jitter Buffer"). The setting has always functioned as a jitter buffer (holding PCM frames to smooth WebSocket-to-Sonos delivery variance), so the name now matches the role.

  Sets up a follow-up change that turns this from a passive sizing hint into an active fill-gate / refill-on-underrun state machine.

- [#72](https://github.com/brew-lab/thaumic-cast/pull/72) [`8e409b6`](https://github.com/brew-lab/thaumic-cast/commit/8e409b6ac9a1297cde61a3faee5c2336b10c2437) Thanks [@skezo](https://github.com/skezo)! - Add opt-in setting for synchronized multi-speaker playback

  Synchronized group playback is now controlled by a user setting rather than being automatic. This allows users who prefer independent streams (and are okay with potential audio drift) to keep their existing Sonos speaker groupings unchanged.

  **Changes:**
  - Add "Synchronize speakers" toggle in Options > Advanced section
  - Add `syncSpeakers` field to extension settings (default: false)
  - Thread `syncSpeakers` flag through the message chain from extension to server
  - Store `syncSpeakers` preference in session for resume/reconnect scenarios
  - Server uses independent playback when `syncSpeakers` is false

  **Behavior:**
  - Setting disabled (default): Each speaker receives independent streams
  - Setting enabled: Speakers are grouped via x-rincon protocol for perfect sync
  - Single speaker casts are unaffected by this setting
  - Resume after pause respects the original sync preference from cast start
