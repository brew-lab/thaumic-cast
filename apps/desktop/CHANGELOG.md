# @thaumic-cast/desktop

## 0.12.1

### Patch Changes

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`facaa7e`](https://github.com/brew-lab/thaumic-cast/commit/facaa7ee2f296c3183ba51439e18aeb09b228c44) Thanks [@skezo](https://github.com/skezo)! - fix(extension): capture the browser that is casting, not the one that started first

  Browser-wide capture attaches to one browser's process tree, and the extension never said which browser it was, so
  the companion captured whichever supported browser had the lowest process id. On a machine where another browser sat
  in the background that was the wrong one, and the result was a perfectly timed stream of silence. The extension now
  names its own browser, using the client-hint brands where the user agent string would disguise it, and the companion
  falls back to auto-detection with a warning if that browser is not found, logging every candidate when it has to guess.

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

- [#215](https://github.com/brew-lab/thaumic-cast/pull/215) [`6b69f4b`](https://github.com/brew-lab/thaumic-cast/commit/6b69f4b5b54f03793932aa2c36348e35d06b872d) Thanks [@skezo](https://github.com/skezo)! - fix(desktop): stop a console window flashing on Windows

  To tell the extension whether browser-wide capture can work, the desktop app checked the Windows version by running `reg.exe`, and it did so on every request the extension made to `/health`. Each run flashed a console window for a moment. The version is now read inside the app, so no program starts and nothing flashes. Machines where a policy blocks registry tools now get the right answer too, where before capture was reported as unavailable.

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

- [#228](https://github.com/brew-lab/thaumic-cast/pull/228) [`0a76a54`](https://github.com/brew-lab/thaumic-cast/commit/0a76a54f81b7f33a1469aac28b9a5bf344954d79) Thanks [@skezo](https://github.com/skezo)! - feat(desktop): copy a running cast's URL from its speaker card

  A casting speaker's card in the Speakers view now has a "Copy URL" button, shown while the cast runs. The URL opens the cast in VLC or a browser, on this computer or another device on your network, through the listen route. It is built afresh from this computer's current address each time, so it stays right after an IP change, and it carries `.wav` for PCM casts and `.flac` for FLAC. The copy starts inside the click, so the macOS and Linux webviews allow it. A note says the player does not keep time with the speakers, and for a PCM cast on Windows a second note warns that with browser-wide capture the browser would cast it back. If the clipboard refuses the URL, it is shown selected for copying by hand.

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

- [#211](https://github.com/brew-lab/thaumic-cast/pull/211) [`87f28da`](https://github.com/brew-lab/thaumic-cast/commit/87f28da7d36d38fb73a3d7164eddba62066b704b) Thanks [@skezo](https://github.com/skezo)! - fix(server,desktop): warn about a key that is not read, and keep the good settings when one is bad

  A key in the server's config file that the server does not read, a misspelt one included, used to be dropped without
  a word. Each one now gets a warning in the log naming the key and the file, and when it is close to a real key
  (`bind_prot`, `pcmConnectBurstMs`) and the file does not have the real key as well, the warning names it and says the
  line did not set it. A file whose keys cannot be checked, because one the server does not read is written twice, gets
  one line saying so. The server still starts. A bad value for a real key still stops it, as before.

  In the desktop app, one unusable value in `settings.json` used to reset all three settings to their defaults. Each
  setting is now read on its own: the unusable one takes its default, the others keep their values, and the log says
  which one it was and that the next save of any setting replaces it in the file. A key the app does not read is warned
  about and ignored, and is gone from the file the next time a setting is saved. A setting written twice in the file
  used to count as an unusable file; the later value is now the one used.

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

- [#195](https://github.com/brew-lab/thaumic-cast/pull/195) [`e606ab8`](https://github.com/brew-lab/thaumic-cast/commit/e606ab8a9f181dbf50c39477013c8b0a9009cef1) Thanks [@skezo](https://github.com/skezo)! - fix(extension,desktop): show a proper message where a code or the wrong text showed

  A few messages appeared as an internal code, such as `error_offscreen_unavailable`, when a cast failed to start. They
  now read as sentences. Adding a speaker by IP address in the desktop app always gave the same vague line; it now says
  whether the address could not be reached, is not a Sonos speaker, or is not an IP address at all.

  On Mac and Linux the extension no longer recommends browser-wide capture when audio is dropping, since that setting
  only exists on Windows, and the desktop app's first-run screens no longer flash the Windows wording before showing
  your platform's. When a speaker cut out because its head start had already been used up, the notice no longer claims
  the Wi-Fi delay was longer than the head start.

  Counts now read correctly for one: "1 speaker", "+1 other", "late 1 time". The button on a connection error reads
  "Try again" when nothing was found and "Reconnect" only when a connection was lost. The tray tooltip after Stop All
  Streams is two plain sentences, and appears only when a cast from another machine was stopped. A settings or
  codec-detection failure in the extension now shows its translated message, not the raw error.

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

- [#199](https://github.com/brew-lab/thaumic-cast/pull/199) [`b2d3fd5`](https://github.com/brew-lab/thaumic-cast/commit/b2d3fd546d88fe4be39c0b289ff5dcd4502bd0bb) Thanks [@skezo](https://github.com/skezo)! - feat(desktop): rewrite the Speakers and Server views, the first-run tour and the tray menu

  The desktop app's Speakers and Server views, its first-run tour and its tray menu have been rewritten. Ending casts
  says "Stop all casts" everywhere, the scan button says "Ask again", and each Server action now says what it will
  cost, such as "Closes Thaumic Cast and opens it again, which ends every cast on the way." Adding a speaker by IP
  address explains what went wrong and what to check. The Settings view is unchanged.

- [#197](https://github.com/brew-lab/thaumic-cast/pull/197) [`0853a4d`](https://github.com/brew-lab/thaumic-cast/commit/0853a4d580f8166865ce519afba5d7318c88644b) Thanks [@skezo](https://github.com/skezo)! - fix(extension,desktop): reword the speaker notices and the late-audio notice

  The notices that appear when a speaker cuts out, nearly cuts out, runs low or has a fast clock now say what happened
  first, with the figures, and end on what to set: "Kitchen cut out: the Wi-Fi stalled for 600 ms, and a 500 ms head
  start lasts 500 ms. Set it to 750 ms." The notice for audio reaching the companion late is reworded the same way. The
  unplayed audio at a speaker is called its reserve throughout, and both buttons now read "Open Settings". Nothing about
  when a notice appears has changed.

- [#213](https://github.com/brew-lab/thaumic-cast/pull/213) [`8c2e81c`](https://github.com/brew-lab/thaumic-cast/commit/8c2e81cf40eabc3930705052d24154113999212a) Thanks [@skezo](https://github.com/skezo)! - fix(extension,desktop): reword the settings pages

  Every label and line of help on the extension's Settings page and in the desktop app's Settings view has been
  rewritten. Each line of help now says what the setting does and when a change takes effect: the extension's audio,
  video sync, keep-awake, speaker and capture settings from the next cast you start, and the desktop app's speaker
  settings when a speaker next connects.

  The settings use the same words as the notices: reserve, speaker head start, smoothing and clock drift correction.

  Some labels have changed, so here is where things went:
  - Extension: "Server" is now "Companion", with "Find it automatically" and "Enter the address". "Audio Quality" is
    "Audio". "Here Be Dragons" is "Finer points". "Video sync controls" is "Video sync". "Synchronize speakers" is "Play
    speakers as one group".
  - Desktop app: "Keep an eye on speakers" is "Speaker monitoring". "Hand-added" is "Added by IP address", and its
    button says "Remove speaker".

  The Quality names (Economical, Sensible, Luxurious, Bespoke) are the same. No setting behaves differently.

  The server's install script now prints "Server address", the name of the field the address goes in.

- [#137](https://github.com/brew-lab/thaumic-cast/pull/137) [`0342009`](https://github.com/brew-lab/thaumic-cast/commit/0342009aabfdc4848dd44e49363793d8e0040e98) Thanks [@skezo](https://github.com/skezo)! - fix(core): recover audio quality after stalls instead of skipping until restart

  After any underrun the cadence stream resumed on the very first frame, leaving the jitter buffer empty; with browser
  (WASAPI) capture delivering exactly one packet per tick it could never refill, so every later hiccup was an audible
  skip until the app was restarted. Playback is now held on silence until the queue is back at the configured jitter
  depth, with a timeout of twice that depth counted from when frames resume, and frames that arrived just before a
  tick no longer count as an underrun. On Windows, audio the engine discarded (`DATA_DISCONTINUITY`, measured from the
  device position and bounded by wall-clock time) is backfilled with the same duration of silence starting with a
  fade-out, packets flagged silent are zero-filled, and the first packet after a loss is faded in. Stream summaries now
  report `rebuffers`.

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

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`cd68ff2`](https://github.com/brew-lab/thaumic-cast/commit/cd68ff2463150a62dbb722ec0ca9cc37f7aa20b0) Thanks [@skezo](https://github.com/skezo)! - feat(desktop): add the speaker head start setting and show speaker notices

  Settings > Speakers gains a speaker head start select (Off, 250, 500, 750, 1000, 1500 or 2000 ms; a value set by hand
  in settings.json shows as Custom), saved with the other desktop settings and applied from each speaker's next
  connection. When `THAUMIC_PCM_CONNECT_BURST_MS` is set, the select shows its value, is disabled, and says why. The
  "Speaker monitoring" description now says what the monitor measures and that turning it off also turns off
  speaker notices. The Speakers view shows the speaker notices the core decides for each speaker playing a stream,
  worded as in the extension, with an Open settings button for head-start advice. A notice shows only while its speaker
  plays the stream it is about, and the notices clear when speaker monitoring is turned off. A dismissed notice stays
  dismissed while it is repeated, and the same head-start advice for the same speaker stays dismissed for 24 hours or
  until the app quits, whichever comes first. The onboarding note on expectations now says audio reaches the speakers
  about a second after it plays.

- [#226](https://github.com/brew-lab/thaumic-cast/pull/226) [`a96e3b3`](https://github.com/brew-lab/thaumic-cast/commit/a96e3b38ecb5e4f0753d779daf156665c9ddbf23) Thanks [@skezo](https://github.com/skezo)! - fix(desktop): say a speaker is in use when something else is playing on it

  A speaker card read "Playing" whenever the speaker played anything, so a speaker playing from another app looked the same as one playing a cast of ours. It now reads "In use", in an amber badge, when something else is playing on it. "Loading", "Paused" and "Not playing" are unchanged, and a speaker with one of our casts still reads "Casting".

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

- [#187](https://github.com/brew-lab/thaumic-cast/pull/187) [`67f86db`](https://github.com/brew-lab/thaumic-cast/commit/67f86db9a81fc1c9ed6850af9a3c91a66c0d350d) Thanks [@skezo](https://github.com/skezo)! - feat(core): say when clock drift made a speaker run low

  On a long cast the drift notice came first and running low then replaced it for the rest of the cast, saying only
  how much audio the speaker had left: the cause and the remedy were gone. A running-low notice now carries
  `cause: "drift"` when the speaker's clock is measurably draining the reserve, net of any correction, by at least
  5 ppm, has drained at least half of what the reserve lost since it settled, and no stall or poor link explains the
  loss. The popup and the dashboard then add that the speaker plays slightly faster than the audio
  arrives, offer clock drift correction where it is not on (as the drift notice does), and keep the restart advice.

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

- [#209](https://github.com/brew-lab/thaumic-cast/pull/209) [`6a5f60c`](https://github.com/brew-lab/thaumic-cast/commit/6a5f60cfcfcbaf3fab0a01e37a2186e76e7fe993) Thanks [@skezo](https://github.com/skezo)! - feat(extension,desktop): hide the language pickers until there is a second language

  The Language section in the extension's options and in the desktop app's Settings offered one choice, English. Both are
  now hidden, and come back by themselves when a second language ships. Nothing else on either page moves.

  The extension used to store English as your language even though you never picked it, which would have kept you on
  English after a translation for your browser's language arrived. The stored language can now be "auto", meaning follow
  the browser, and that is the default. A stored English is changed to "auto" once, when this version first loads the
  settings. After that, English picked in the Language section is your choice and is kept. Every other setting is
  unchanged.

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

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`a8b9c7e`](https://github.com/brew-lab/thaumic-cast/commit/a8b9c7eb726234e71a5f58888d05e0fd051b106d) Thanks [@skezo](https://github.com/skezo)! - fix(ui): restore button group spacing and let the theme change without a reload

  Two faults, both a class name that never resolved. The button group built its spacing and alignment class names from
  its props, but the build exports only camel-case keys while the stylesheet uses hyphenated names, so those lookups
  found nothing and were dropped, leaving every wizard screen without spacing or alignment. The sidebar brand icon had
  the same fault. Separately, the page wrote an inline colour scheme before painting, which outranks the stylesheet that
  maps the theme attribute, so once written it never changed and choosing a theme had no visible effect until a reload.
  The attribute alone is enough, because the style block on the same page already maps it.

  Closes [#110](https://github.com/brew-lab/thaumic-cast/issues/110)
  Closes [#114](https://github.com/brew-lab/thaumic-cast/issues/114)

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

- Updated dependencies [[`44b237d`](https://github.com/brew-lab/thaumic-cast/commit/44b237db820faf85e1bf5eaea043888888e64386), [`644a955`](https://github.com/brew-lab/thaumic-cast/commit/644a955100483f155176286cf74fa0bb2627a400), [`dd1bf05`](https://github.com/brew-lab/thaumic-cast/commit/dd1bf057cdffa6806ee3bad2fc55a4e5c3843564), [`0a7c6b6`](https://github.com/brew-lab/thaumic-cast/commit/0a7c6b67299c159410efc4eaa8d27a1c922d653e), [`a079ad9`](https://github.com/brew-lab/thaumic-cast/commit/a079ad9f678a2ad25553e0d0b6c3c90e427989da), [`f833ba4`](https://github.com/brew-lab/thaumic-cast/commit/f833ba45fb46cddcc4802af40fc3977b907a50fa), [`ca7f19d`](https://github.com/brew-lab/thaumic-cast/commit/ca7f19dfa1385c2a4bd7cb1d18074a8d9f5215ad), [`d8efc83`](https://github.com/brew-lab/thaumic-cast/commit/d8efc833ce9a7dab677cea30d9e490fbe72c25f6), [`67f86db`](https://github.com/brew-lab/thaumic-cast/commit/67f86db9a81fc1c9ed6850af9a3c91a66c0d350d), [`c219d46`](https://github.com/brew-lab/thaumic-cast/commit/c219d4693303063d6934d3cec8d28d20b980b97e), [`09d86b0`](https://github.com/brew-lab/thaumic-cast/commit/09d86b033f9b2db0408d7066839a25a9a158db1d), [`6ed39cd`](https://github.com/brew-lab/thaumic-cast/commit/6ed39cd3c0ae72678b56fa1a2f72ee650d650674), [`602c9ee`](https://github.com/brew-lab/thaumic-cast/commit/602c9ee2ff71b41f4added085bda4a48c1d1154c), [`a8b9c7e`](https://github.com/brew-lab/thaumic-cast/commit/a8b9c7eb726234e71a5f58888d05e0fd051b106d)]:
  - @thaumic-cast/protocol@0.6.0
  - @thaumic-cast/ui@4.0.0

## 0.12.0

### Minor Changes

- [#68](https://github.com/brew-lab/thaumic-cast/pull/68) [`a7d3d23`](https://github.com/brew-lab/thaumic-cast/commit/a7d3d23ea2fe6bc5deae53cb905751a38fc5559e) Thanks [@skezo](https://github.com/skezo)! - Add bi-directional playback control between extension and Sonos

  When casting, playback state now syncs in both directions:
  - **Sonos → Browser**: Pause/play on Sonos remote or app controls the browser tab
  - **Browser → Sonos**: Play in browser (YouTube controls, keyboard shortcuts) resumes Sonos

  Technical improvements:
  - Use per-speaker epoch tracking for accurate resume detection
  - Delegate playback decisions to server for consistent state handling
  - Send Play command unless speaker is definitively playing (handles cache misses)
  - Deduplicate Play commands on PCM resume to prevent audio glitches
  - Add error handling for broker failures during playback notifications

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

### Patch Changes

- [#97](https://github.com/brew-lab/thaumic-cast/pull/97) [`4f5bfff`](https://github.com/brew-lab/thaumic-cast/commit/4f5bfff695e70cccb81c0b6601603f63e877c3f7) Thanks [@skezo](https://github.com/skezo)! - Bump Cargo dependencies. `cargo update` for in-range patch/minor bumps across the workspace (tokio 1.49 → 1.52, tauri 2.10.2 → 2.10.3, rustls 0.23.36 → 0.23.38, etc.). Two direct major bumps: `mdns-sd` 0.17 → 0.19 (used by `thaumic-core` for Sonos discovery and `thaumic-cast-desktop` for service advertisement; APIs we use are unchanged) and `rust-i18n` 3 → 4 (used by the desktop tray menu). The `rust-i18n` 4 macro expands to code stable in Rust 1.80, so the desktop crate's `rust-version` is bumped from 1.77 → 1.80.

- [#99](https://github.com/brew-lab/thaumic-cast/pull/99) [`a097322`](https://github.com/brew-lab/thaumic-cast/commit/a0973226e77f104d87544597483c74ef260b3e66) Thanks [@skezo](https://github.com/skezo)! - Harden streaming network path and diagnostic log retention

  Four isolated fixes to the local streaming daemon and desktop app:

  **Core (`thaumic-core`):**
  - TCP_NODELAY on all accepted connections disables Nagle's algorithm so small PCM frames (1920 bytes) ship immediately instead of being batched, reducing delivery jitter to Sonos.
  - TCP keepalive on accepted connections (10s idle, 5s interval, 3 retries on Linux) detects stalled speakers within ~25s instead of the default ~2 hours, preventing async tasks from being held alive on dead connections.
  - SSDP discovery now skips link-local (`169.254.0.0/16`) addresses that cause bind failures on adapters like Bluetooth with no real connectivity, and expands the virtual-interface prefix list (Windows `vEthernet`, WireGuard, Tailscale, ZeroTier) that cannot reach local Sonos speakers.

  **Desktop:**
  - Raises log max file size to 1 MB so pipeline diagnostic dumps survive across sessions without rotation.

- [#97](https://github.com/brew-lab/thaumic-cast/pull/97) [`963170d`](https://github.com/brew-lab/thaumic-cast/commit/963170df0109686df84f47e998b63a1ffb7de6d8) Thanks [@skezo](https://github.com/skezo)! - Bump dev and production dependencies to current major versions: typescript 6, vite 8, i18next 26, react-i18next 17, lucide-preact 1, @changesets/changelog-github 0.6. Adds an `ImportMeta.env` ambient declaration in `@thaumic-cast/shared` so `logger.ts` continues to typecheck under TypeScript 6, and adds `typescript` as a direct devDependency of `@thaumic-cast/extension` so `tsc` resolves locally now that typescript-eslint pins TS 5 and prevents root hoisting.

- [#107](https://github.com/brew-lab/thaumic-cast/pull/107) [`b73b49e`](https://github.com/brew-lab/thaumic-cast/commit/b73b49ea5b15d115cb016f395074891c7f77cc95) Thanks [@skezo](https://github.com/skezo)! - Polish the companion version-mismatch surface introduced in the previous release, and unblock the path that was supposed to surface it for older companions.
  - Accept `INITIAL_STATE` payloads that omit `groupVolumeFixed`. That field was added after the initial protocol shipped; older companions don't send it, so the extension's `WS_CONNECTED` route rejected their messages at schema validation — `handleWsConnected` never ran, the popup stayed stuck at "Checking…", and the out-of-date warning (the very UI meant for this scenario) never had a chance to render. The `groupVolumeFixed` field now defaults to an empty map when missing, so older-companion payloads validate and the version-mismatch flow fires as designed.
  - Prevent the out-of-date warning Alert from briefly flashing on every initial connection. The popup was flipping `phase` to `'connected'` optimistically on `WS_STATE_CHANGED` before the async fetch that carries the companion metadata resolved, so `protocolVersion` was transiently `null` and the mismatch helper would light up the Alert for a single render. The connection-status hook now only transitions to `'connected'` via the metadata-bearing `CACHED_STATE_RECEIVED`, applying phase and metadata atomically. The companion-version hook additionally gates on `phase === 'connected'` so no flash window can open between discovery and WebSocket `INITIAL_STATE`.
  - Gate the Alert on the persisted dismissal record having loaded, closing a smaller race where a previously-dismissed warning briefly reappeared on popup open before `chrome.storage.local` resolved.
  - Rename the protocol line in the extension About card and the desktop Settings About card from `Protocol v{{version}}` to `Protocol · Version {{version}}`, matching the adjacent `Desktop App · Version {{version}}` / `Version {{version}}` format.

- [#105](https://github.com/brew-lab/thaumic-cast/pull/105) [`32ae247`](https://github.com/brew-lab/thaumic-cast/commit/32ae2471d81ace318b32080badceb578b8019ae5) Thanks [@skezo](https://github.com/skezo)! - Rename `streamingBufferMs` setting to `jitterBufferMs` across the stack

  Pure rename — no behavior change. Every value, default, clamp range, and UI option stays the same. Identifier updated on the protocol, core, extension, and desktop surfaces, plus docstrings and the one user-facing label ("Streaming Buffer" → "Jitter Buffer"). The setting has always functioned as a jitter buffer (holding PCM frames to smooth WebSocket-to-Sonos delivery variance), so the name now matches the role.

  Sets up a follow-up change that turns this from a passive sizing hint into an active fill-gate / refill-on-underrun state machine.

- [#81](https://github.com/brew-lab/thaumic-cast/pull/81) [`327a9f2`](https://github.com/brew-lab/thaumic-cast/commit/327a9f2f683a91d13e188fc09788f05ca65883f3) Thanks [@skezo](https://github.com/skezo)! - Update @tauri-apps/cli to match tauri crate version

  CLI 2.9.6 could not locate the `__TAURI_BUNDLE_TYPE` marker embedded by tauri crate 2.10.2, causing a build warning and breaking the updater plugin's bundle type detection.

- Updated dependencies [[`48c068f`](https://github.com/brew-lab/thaumic-cast/commit/48c068f1fd3751fa6796997229692167913ba68a), [`77a19e2`](https://github.com/brew-lab/thaumic-cast/commit/77a19e21150e6b7cd35af44fb3bd6d47edc4d636), [`963170d`](https://github.com/brew-lab/thaumic-cast/commit/963170df0109686df84f47e998b63a1ffb7de6d8), [`b73b49e`](https://github.com/brew-lab/thaumic-cast/commit/b73b49ea5b15d115cb016f395074891c7f77cc95), [`a01a1c4`](https://github.com/brew-lab/thaumic-cast/commit/a01a1c4bd61ff52bddb5d244ca8361fd0a127351), [`153a447`](https://github.com/brew-lab/thaumic-cast/commit/153a44754061c3d57d101d227d4654a863f201d9), [`32ae247`](https://github.com/brew-lab/thaumic-cast/commit/32ae2471d81ace318b32080badceb578b8019ae5), [`f958485`](https://github.com/brew-lab/thaumic-cast/commit/f9584852e7e2649435ff231d01352195c65c59d9), [`facd9e8`](https://github.com/brew-lab/thaumic-cast/commit/facd9e8d5814807947193c2fd8e80b566223bb38)]:
  - @thaumic-cast/ui@3.0.0
  - @thaumic-cast/protocol@0.5.0
  - @thaumic-cast/shared@0.1.0

## 0.11.0

### Patch Changes

- [#63](https://github.com/brew-lab/thaumic-cast/pull/63) [`e0420a4`](https://github.com/brew-lab/thaumic-cast/commit/e0420a4c97101f2d0e641a48b24382a1c1804cc7) Thanks [@skezo](https://github.com/skezo)! - fix(desktop): prevent theme flash on app startup
  - Start window hidden and show after frontend initialization
  - Add inline theme initialization in HTML to apply correct theme before CSS loads
  - Respect --minimized flag for tray-only startup mode

- [#51](https://github.com/brew-lab/thaumic-cast/pull/51) [`0a194c2`](https://github.com/brew-lab/thaumic-cast/commit/0a194c21329e7b4acdbb517133d82a21340d5bf3) Thanks [@skezo](https://github.com/skezo)! - Bump JavaScript and Rust dependencies

- [#55](https://github.com/brew-lab/thaumic-cast/pull/55) [`0a65014`](https://github.com/brew-lab/thaumic-cast/commit/0a65014003695131bca25c432bc051e8015ea75a) Thanks [@skezo](https://github.com/skezo)! - Optimize Tauri build configuration and security settings
  - Use selective tokio features instead of "full" for smaller binaries
  - Enable `removeUnusedCommands` to strip unused IPC commands
  - Set default window size to 840×560 with 480×360 minimum
  - Add `acceptFirstMouse` and disable `tabbingIdentifier` for macOS
  - Disable browser zoom hotkeys (OS-level zoom still available)
  - Enable CSP for XSS protection
  - Add missing `core:tray:default` and `core:window:default` capabilities

- [#64](https://github.com/brew-lab/thaumic-cast/pull/64) [`36b0c9f`](https://github.com/brew-lab/thaumic-cast/commit/36b0c9fe5af688a692756eb3f066b494d0ae8441) Thanks [@skezo](https://github.com/skezo)! - Add partial speaker removal for multi-group casts
  - Add per-speaker remove button (X) to ActiveCastCard, shown only when 2+ speakers
  - Send STOP_PLAYBACK_SPEAKER command to remove individual speakers without stopping entire cast
  - Track user-initiated vs system removals for accurate analytics (user_removed reason)
  - Stop latency monitoring when a speaker is removed
  - Add translations for user_removed auto-stop reason
  - Sort speakers alphabetically for consistent UI ordering (extension and desktop)

  UX improvements:
  - Add 48px touch target to volume slider for better accessibility (WCAG 2.5.5)
  - Add CSS tokens for slider dimensions, touch target size, and muted state opacity
  - Disable text selection on interactive controls (volume, speaker rows, popup header/footer)
  - Allow text selection only on track info sections (title, subtitle)
  - Use semantic CSS tokens for disabled/muted opacity states

- [#55](https://github.com/brew-lab/thaumic-cast/pull/55) [`3a12f9a`](https://github.com/brew-lab/thaumic-cast/commit/3a12f9aea098aeda38ee956827bb837ce7304e07) Thanks [@skezo](https://github.com/skezo)! - Add hash-based scroll navigation for linking to settings sections

- [#58](https://github.com/brew-lab/thaumic-cast/pull/58) [`d95b5ed`](https://github.com/brew-lab/thaumic-cast/commit/d95b5ed0561656c328a01d40eaf2467ee392089f) Thanks [@skezo](https://github.com/skezo)! - Streamline onboarding flow: add GitHub download link, simplify firewall messaging, reorder ReadyStep layout

- Updated dependencies [[`94102c1`](https://github.com/brew-lab/thaumic-cast/commit/94102c1444f01b81c23e43ae4c56c731d71579c3), [`36b0c9f`](https://github.com/brew-lab/thaumic-cast/commit/36b0c9fe5af688a692756eb3f066b494d0ae8441), [`3a12f9a`](https://github.com/brew-lab/thaumic-cast/commit/3a12f9aea098aeda38ee956827bb837ce7304e07)]:
  - @thaumic-cast/ui@2.0.0
  - @thaumic-cast/protocol@0.3.0

## 0.10.4

## 0.10.3

### Patch Changes

- [#47](https://github.com/brew-lab/thaumic-cast/pull/47) [`b8b75b1`](https://github.com/brew-lab/thaumic-cast/commit/b8b75b1c21c8b462238c8df6b7e3a27cab0b4310) Thanks [@skezo](https://github.com/skezo)! - Update Chrome Web Store link in onboarding to point to the published extension listing.

## 0.10.2

## 0.10.1

## 0.10.0

### Minor Changes

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`6921795`](https://github.com/brew-lab/thaumic-cast/commit/6921795b559217b5ee5342852e7c59b80fc858d4) Thanks [@skezo](https://github.com/skezo)! - Add mDNS service discovery and user-configurable streaming buffer

  **mDNS Service Advertisement**
  - Advertise Thaumic Cast as `_thaumic._tcp.local.` for native client discovery
  - Unique instance name per hostname to avoid conflicts
  - TXT records include http_path, ws_path, and version
  - Auto-unregisters on shutdown; best-effort if mDNS unavailable

  **User-Configurable Streaming Buffer**
  - Add streaming buffer setting (100-1000ms, default 200ms) for PCM mode
  - Higher values provide more jitter absorption at the cost of latency
  - Exposed in extension Audio options panel
  - Dynamically derives WAV cadence queue size from buffer setting

  **Extension Improvements**
  - Skip redundant metadata cache updates for better performance
  - Reduce keep-audible gain and optimize PCM conversion
  - Add error handling for Zod validation in offscreen handlers
  - Post stats during sustained backpressure
  - Use interactive latency hint for realtime mode
  - Handle WebSocket close during handshake gracefully
  - Reject unsupported audio sample rates with clear error

  **Architecture**
  - Extract thaumic-core crate with Sonos client, stream management, and API layer
  - Centralize background task startup and add server IP auto-detection
  - Require explicit runtime handle in bootstrap for predictable initialization

  **Bug Fixes**
  - Align stream URL path with HTTP route
  - Align GENA route with callback URL
  - Use generic SERVICE_ID for health endpoint discovery

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`cbbe631`](https://github.com/brew-lab/thaumic-cast/commit/cbbe6312d28c029d6c8f4bd9d716452e2baf9a60) Thanks [@skezo](https://github.com/skezo)! - Add configurable artwork resolution with precedence chain

  **New Artwork Module (thaumic-core)**
  - Add `ArtworkConfig` and `ArtworkSource` types for flexible artwork configuration
  - Support precedence chain: external HTTPS URL > `data_dir/artwork.jpg` > embedded default
  - External URL option enables Android Sonos app compatibility (requires HTTPS)
  - Single `read()` call with `NotFound` handling avoids TOCTTOU race

  **Server Configuration**
  - Add `artwork_url` config option and `THAUMIC_ARTWORK_URL` env var
  - Document artwork precedence in `config.example.yaml`

  **API Changes**
  - Replace `AppStateBuilder::artwork(&[u8])` with `artwork_config(ArtworkConfig)`
  - Add `AppState::artwork_metadata_url()` for Sonos DIDL-Lite metadata
  - Pass artwork URL through `start_playback()` and `start_playback_multi()`

  **Desktop App**
  - Cache resolved `ArtworkSource` to avoid disk I/O on every playback; URL computed on-demand with current IP/port
  - Support custom artwork via `artwork.jpg` in app data directory

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`19c7e2b`](https://github.com/brew-lab/thaumic-cast/commit/19c7e2b971ceb3595a759ab3068141bdce318812) Thanks [@skezo](https://github.com/skezo)! - Add crossfade on silence transitions to eliminate audio pops

  **Crossfade on Silence Transitions**
  - Apply 2ms linear fade-out when entering silence (audio → silence)
  - Apply 2ms linear fade-in when exiting silence (silence → audio)
  - Track last sample pair for fade-out generation
  - Cap fade samples to available frame size for short frame durations

  **Channel Validation**
  - Reject channel counts other than 1 (mono) or 2 (stereo) in handshake
  - Crossfade utilities require mono/stereo; multi-channel is not supported

  **AudioFormat Helpers**
  - Add `bytes_per_sample()` and `frame_samples()` methods
  - Add `is_crossfade_compatible()` check for 16-bit PCM validation

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`2109faf`](https://github.com/brew-lab/thaumic-cast/commit/2109faf6fa40452a56789ddd08f22ccf08d884bb) Thanks [@skezo](https://github.com/skezo)! - Extract core streaming logic into thaumic-core crate

  **Architectural Refactor**

  Extract the core Sonos streaming logic from the desktop app into a standalone Rust library (`packages/thaumic-core`). This enables:
  - Headless server deployments without Tauri/GUI dependencies
  - Shared code between desktop app and standalone server
  - Cleaner separation of concerns

  **New Abstractions**
  - `EventEmitter` trait: Pluggable event dispatch (Tauri events, WebSocket broadcast, etc.)
  - `Context`: Shared application state with runtime handles
  - `StreamingRuntime`: Dedicated high-priority runtime for audio streaming
  - `bootstrap_services()`: Unified service initialization

  **Modules Migrated**
  - Sonos client, discovery (SSDP/mDNS), GENA subscriptions
  - Stream manager, WAV/ICY formatters, transcoder
  - HTTP API routes, WebSocket handlers
  - All background services (topology monitor, latency monitor, etc.)

  The desktop app now depends on thaumic-core and provides only Tauri-specific glue code.

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`4082c40`](https://github.com/brew-lab/thaumic-cast/commit/4082c40e2b7bef74d4a46d61c7325880a2169ddd) Thanks [@skezo](https://github.com/skezo)! - Improve WAV streaming reliability for Sonos speakers

  **WAV Stream Stability**
  - Inject silence frames during delivery gaps to prevent Sonos disconnection (WAV streams require continuous data flow)
  - Use fixed Content-Length header instead of chunked transfer encoding (some renderers stutter with chunked)
  - Add upfront buffer delay (250ms) before serving audio to reduce early-connection jitter sensitivity
  - Cache silence frames globally to avoid ~200KB/s allocations during delivery gaps
  - Add TransferMode.dlna.org and icy-name headers to all audio streams for DLNA compatibility
  - Elevate process priority to reduce audio stuttering under CPU load (HIGH_PRIORITY_CLASS on Windows, nice -10 on Unix)
  - Enrich DIDL-Lite metadata with audio format attributes (sampleFrequency, nrAudioChannels, bitsPerSample)

  **Epoch Tracking Accuracy**
  - Introduce TaggedFrame enum to distinguish real audio from injected silence
  - Only fire epoch on real audio frames, not silence or empty buffers
  - Reorder subscribe/delay sequence for more accurate timing

  **Race Condition Fixes**
  - Add stream_id to PlaybackStopped event to prevent incorrect session cleanup during recast
  - Stop old playback before starting new stream on same speaker to ensure clean source switching

  **Configuration & Architecture**
  - Extract StreamingConfig struct with validation (max_concurrent_streams, buffer_frames, channel_capacity)
  - Wire streaming config through bootstrap chain for proper dependency injection
  - Add unit tests for StreamingConfig validation and AudioFormat calculations

  **Observability**
  - Add HTTP stream lifecycle logging (start/end, frames sent, delivery gaps)
  - Log frame delivery gap instrumentation (max gap, gaps over threshold)
  - Log broadcast channel lag errors and JSON serialization failures
  - Document TOCTOU mitigation in GENA subscription store

  **Other**
  - Add Windows debug build script
  - Add resolve.dedupe for Windows monorepo compatibility

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`f158fb2`](https://github.com/brew-lab/thaumic-cast/commit/f158fb22a398e1adcac5b344b118a10a9bdcde61) Thanks [@skezo](https://github.com/skezo)! - Preserve Float32 audio throughout pipeline to enable 24-bit FLAC encoding

  **Audio Pipeline Refactor**
  - Keep Float32 samples throughout the audio pipeline (AudioWorklet → ring buffer → encoders) instead of early Int16 quantization
  - Change ring buffer from Int16Array to Float32Array to preserve full precision
  - Move Int16 quantization to PCM encoder as the final step before wire transmission
  - Enable 24-bit FLAC encoding without precision loss from the audio source

  **24-bit FLAC Support**
  - Add `bitsPerSample` field to `EncoderConfig` (16 or 24, default 16)
  - FLAC encoder uses s32-planar format scaled to 24-bit range when configured for 24-bit
  - Validate that 24-bit encoding is only allowed for FLAC codec (Sonos S2 requirement)
  - Extract and verify actual bit depth from FLAC header, warn on mismatch

  **Clipping Detection**
  - Track clipped samples (NaN, values outside [-1, 1]) in PCM processor
  - Report clipping count via heartbeat messages for audio quality diagnostics
  - Replace NaN values with 0 to prevent undefined encoder behavior

  **Encoder Optimizations**
  - Pre-allocate ADTS header buffer in AAC encoder (only bytes 3-6 vary per frame)
  - Reuse output queue array instead of reallocating to reduce GC pressure
  - Add detailed documentation for ADTS header structure and bit field layout

  **WAV Header Updates**
  - Support variable bit depth (16 or 24) in WAV header generation
  - Validate bits_per_sample in WebSocket handshake, reject invalid values
  - Calculate byte_rate and block_align dynamically based on bit depth

### Patch Changes

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`3f07d14`](https://github.com/brew-lab/thaumic-cast/commit/3f07d14365f3798baea4e34c37a42ced545529ad) Thanks [@skezo](https://github.com/skezo)! - Add manual speaker IP management API to standalone server

  **New HTTP Endpoints (thaumic-server)**
  - `POST /api/speakers/manual/probe` - Validate IP and probe for Sonos speaker
  - `POST /api/speakers/manual` - Add manual speaker (probes before persisting)
  - `DELETE /api/speakers/manual/:ip` - Remove manual speaker (with fallback for legacy entries)
  - `GET /api/speakers/manual` - List manual speaker IPs

  **Server Configuration**
  - Add `--data-dir` CLI option and `THAUMIC_DATA_DIR` env var for persistence
  - Add `data_dir` field to config.yaml
  - Return 503 SERVICE_UNAVAILABLE when data_dir not configured

  **Shared Code (thaumic-core)**
  - Add `validate_speaker_ip()` with `IpValidationError` enum
  - Add `ErrorCode` trait implementation for consistent error codes
  - Export `ErrorCode` trait for use by consumers
  - Add `set_app_data_dir(impl AsRef<Path>)` for flexible path passing

  **Desktop Refactoring**
  - Use shared `validate_speaker_ip()` instead of inline validation
  - Import `ErrorCode` trait for IP validation error handling

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`2109faf`](https://github.com/brew-lab/thaumic-cast/commit/2109faf6fa40452a56789ddd08f22ccf08d884bb) Thanks [@skezo](https://github.com/skezo)! - Add collapsible sidebar with intrinsic design
  - Sidebar can now be collapsed to icon-only mode for more content space
  - Collapse state persists across sessions via app store
  - Smooth CSS transitions for expand/collapse animation
  - Icons remain visible and functional in collapsed state
  - Responsive behavior adjusts to container width

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`896fabc`](https://github.com/brew-lab/thaumic-cast/commit/896fabc8df8a5b42ec400c48103ccaada8d2485f) Thanks [@skezo](https://github.com/skezo)! - Improve resilience to CPU spikes during audio streaming
  - Increase broadcast channel capacity from 100 to 500 frames (~10 seconds of buffer instead of ~2 seconds), allowing HTTP clients to absorb longer delivery delays without disconnecting
  - Increase WebSocket heartbeat timeout from 10 to 30 seconds, reducing spurious disconnects during system-wide CPU contention

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`478ab65`](https://github.com/brew-lab/thaumic-cast/commit/478ab650978fe271f8857307b835a4e1b61c5262) Thanks [@skezo](https://github.com/skezo)! - Standardize Card usage and mobile-first responsive design

  **Card Component**
  - Add optional `icon` prop that renders before the title (inherits title color via `currentColor`)
  - Add title text truncation support when Card has icons (flexbox layout with span wrapper)

  **Desktop App**
  - Update views to use Card's `title`/`icon` props instead of custom header styles
  - Convert sidebar and views to mobile-first container queries
  - Align Settings toggle layout with Server action row pattern (h4/p structure)
  - Server status card shows operational state with colored icon

  **Extension**
  - Use shared Input component in onboarding for consistent placeholder styling

  **Shared Styles**
  - Standardize input placeholder opacity (0.7) across apps

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`b03c4ee`](https://github.com/brew-lab/thaumic-cast/commit/b03c4ee54ce8c0590ad57a767c1b9315550b3dc4) Thanks [@skezo](https://github.com/skezo)! - Start minimized to system tray when launched via autostart

  When the app is launched with the `--minimized` flag (automatically passed by the autostart plugin), the main window is now hidden on startup, leaving only the system tray icon visible. On macOS, the dock icon is also hidden in this mode.

  This provides a seamless auto-start experience where the app runs in the background without interrupting the user's workflow.

- Updated dependencies [[`6921795`](https://github.com/brew-lab/thaumic-cast/commit/6921795b559217b5ee5342852e7c59b80fc858d4), [`7629de4`](https://github.com/brew-lab/thaumic-cast/commit/7629de408fa0aad7e2a454726d890fb32df3d6ee), [`a8ee07e`](https://github.com/brew-lab/thaumic-cast/commit/a8ee07e4510f88292c9452d8ead84ac79a3d077a), [`9ee78a4`](https://github.com/brew-lab/thaumic-cast/commit/9ee78a4240e0abe22ddff3765baf18988de2f9b3), [`823bbf7`](https://github.com/brew-lab/thaumic-cast/commit/823bbf7ec9cf517ddf5e1076c195de7e05b8be2b), [`4082c40`](https://github.com/brew-lab/thaumic-cast/commit/4082c40e2b7bef74d4a46d61c7325880a2169ddd), [`f158fb2`](https://github.com/brew-lab/thaumic-cast/commit/f158fb22a398e1adcac5b344b118a10a9bdcde61), [`b2d3b7c`](https://github.com/brew-lab/thaumic-cast/commit/b2d3b7c146d183217d79c04004f775c8dbedf0c8), [`08673ee`](https://github.com/brew-lab/thaumic-cast/commit/08673eee4b0c1916f7e4abb79caa49effcffc4f7), [`2109faf`](https://github.com/brew-lab/thaumic-cast/commit/2109faf6fa40452a56789ddd08f22ccf08d884bb), [`478ab65`](https://github.com/brew-lab/thaumic-cast/commit/478ab650978fe271f8857307b835a4e1b61c5262), [`be4e2d0`](https://github.com/brew-lab/thaumic-cast/commit/be4e2d0c281f8f3ec0cb24cbe00bec55c97808d9)]:
  - @thaumic-cast/protocol@0.2.0
  - @thaumic-cast/ui@1.0.0

## 0.9.0

### Minor Changes

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`0bb42f7`](https://github.com/brew-lab/thaumic-cast/commit/0bb42f7d38b93fbb523c87978ef8de066d357b12) Thanks [@skezo](https://github.com/skezo)! - Add manual speaker IP entry for networks where discovery fails
  - Users can manually enter Sonos speaker IP addresses when SSDP/mDNS discovery fails (VPNs, firewalls, network segmentation)
  - IPs are probed to verify they're valid Sonos devices before being saved
  - Manual speakers are merged with auto-discovered speakers during topology refresh
  - Added Input component to shared UI package
  - Manual entry available in onboarding SpeakerStep and Settings view

### Patch Changes

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`5943fa0`](https://github.com/brew-lab/thaumic-cast/commit/5943fa0c896b0b6fce4b3c1d25f4cfa435f17a00) Thanks [@skezo](https://github.com/skezo)! - Convert CSS module classes from camelCase to kebab-case
  - Updated all CSS module class selectors to use kebab-case naming convention
  - Updated corresponding TSX imports to use bracket notation for kebab-case properties
  - Enforced by new stylelint selector-class-pattern rule

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`da980ad`](https://github.com/brew-lab/thaumic-cast/commit/da980ad6a4baf8215e41379f190c252e9b1b9e8b) Thanks [@skezo](https://github.com/skezo)! - Debounce speaker list updates to reduce UI churn
  - Coalesce rapid event bursts (multi-speaker start/stop) into single fetch
  - Reduces API calls from 20+ to 5 during typical multi-speaker operations
  - 150ms debounce window balances responsiveness with efficiency

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`b91f86f`](https://github.com/brew-lab/thaumic-cast/commit/b91f86f3490c0343f454c76eefb4ea6a51ca8ca2) Thanks [@skezo](https://github.com/skezo)! - Use bounded channel for internal GENA events to prevent unbounded memory growth
  - Replaced unbounded channel with bounded channel (capacity 64)
  - Events are dropped with a warning if channel fills (safe since all trigger same recovery)
  - Prevents theoretical memory growth if receiver stalls during event spikes

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`37da618`](https://github.com/brew-lab/thaumic-cast/commit/37da618baaa04c4a314847e6862e026fd9b409ae) Thanks [@skezo](https://github.com/skezo)! - Optimize ICY metadata injection hot path
  - Cache formatted metadata to avoid repeated allocations when metadata unchanged
  - Pre-size output buffers based on expected metadata insertions
  - Lower per-block logging from info to trace level

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`9c37879`](https://github.com/brew-lab/thaumic-cast/commit/9c37879504d915177e9f0c955cb522b353308256) Thanks [@skezo](https://github.com/skezo)! - Reuse scratch buffer in ICY metadata injection to reduce allocation pressure
  - Replace per-chunk Vec allocation with reusable BytesMut buffer
  - Buffer grows to typical chunk size and stabilizes after a few calls
  - Reduces allocator churn on long audio streams

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`e188cd6`](https://github.com/brew-lab/thaumic-cast/commit/e188cd61c44d7f20de9520b8630efbb07be28789) Thanks [@skezo](https://github.com/skezo)! - Use tokio interval instead of sleep for timer loops
  - Reduces timer allocation overhead in WebSocket heartbeat and latency polling
  - Prevents timing drift by compensating for processing time

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`5e94ffd`](https://github.com/brew-lab/thaumic-cast/commit/5e94ffd4d5570e3bd2c7c65ff067c799b18a7712) Thanks [@skezo](https://github.com/skezo)! - Eliminate unnecessary memory copy for passthrough audio streams
  - Changed Transcoder trait to accept `Bytes` instead of `&[u8]`
  - Passthrough now returns input directly without copying
  - Removes ~100 memcpys/second for pre-encoded streams (AAC, FLAC, Vorbis)

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`3743c52`](https://github.com/brew-lab/thaumic-cast/commit/3743c520b35b115c246b6084cb57e20f0d4620d5) Thanks [@skezo](https://github.com/skezo)! - Fix latency session leak when WebSocket handler exits unexpectedly
  - Prune orphaned sessions during poll loop when stream no longer exists
  - Prevents sessions from being polled indefinitely after unexpected disconnects
  - Defense-in-depth cleanup for StreamGuard::drop edge cases

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`add7dd6`](https://github.com/brew-lab/thaumic-cast/commit/add7dd6abbc00b8e655352c64bbc42b1139252e1) Thanks [@skezo](https://github.com/skezo)! - Use allocation-free ASCII case-insensitive parsing for SSDP responses
  - Eliminates multiple string allocations per response during discovery burst
  - Uses byte-level comparison instead of to_lowercase()
  - Improves discovery performance on networks with many speakers

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`b166791`](https://github.com/brew-lab/thaumic-cast/commit/b1667915c0110df2809fe95cfd3028a8636024ba) Thanks [@skezo](https://github.com/skezo)! - Add theme-aware tray icons on Windows
  - Tray icon now adapts to Windows light/dark mode with 4 icon variants (light/dark x idle/active)
  - Icon updates automatically when system theme changes
  - macOS continues to use template icons for native theme adaptation

- Updated dependencies [[`5943fa0`](https://github.com/brew-lab/thaumic-cast/commit/5943fa0c896b0b6fce4b3c1d25f4cfa435f17a00), [`8375f3a`](https://github.com/brew-lab/thaumic-cast/commit/8375f3a50b11df70d428d52a451141257c0b3123), [`0bb42f7`](https://github.com/brew-lab/thaumic-cast/commit/0bb42f7d38b93fbb523c87978ef8de066d357b12), [`070afca`](https://github.com/brew-lab/thaumic-cast/commit/070afca65cc5c323aa0cc2e57117be1e846d04ed)]:
  - @thaumic-cast/ui@0.1.0

## 0.8.4

### Patch Changes

- [#33](https://github.com/brew-lab/thaumic-cast/pull/33) [`a15f0f9`](https://github.com/brew-lab/thaumic-cast/commit/a15f0f9f028a36efcdf66e6c91c3545cc43473d2) Thanks [@skezo](https://github.com/skezo)! - ### Improvements
  - **System Tray**: Add macOS template icons that automatically adapt to light/dark menu bar. The tray icon now switches between idle and active states based on streaming activity.

## 0.8.3

### Patch Changes

- [#32](https://github.com/brew-lab/thaumic-cast/pull/32) [`06490c3`](https://github.com/brew-lab/thaumic-cast/commit/06490c3aebf5c2f9d81b87932001ca9f5f400d8b) Thanks [@skezo](https://github.com/skezo)! - ### Bug Fixes
  - **Speaker Discovery**: Fix race condition where initial scan could miss speakers if discovery completed before the listener was registered. Now fetches existing groups immediately on mount.
  - **Playback Reliability**: Add retry logic with exponential backoff (200ms, 500ms, 1s) for transient SOAP errors (701, 714, 716) when starting playback. Previously, busy speakers would fail immediately requiring manual retry.
  - **GENA Subscriptions**: Only subscribe to coordinators for AVTransport. Satellites (Sub, surrounds) and bridges (Boost) don't support AVTransport and were returning 503 errors.

  ### Code Quality
  - Extract shared Tauri event payload types (`DiscoveryCompletePayload`, `NetworkHealthPayload`, `TransportStatePayload`) to `lib/events.ts`
  - Add `listenOnce` utility for one-shot event listening with timeout fallback
  - Add `SoapError::is_transient()` method to identify retryable errors
  - Add `with_retry` helper for SOAP operations with exponential backoff
  - Consolidate GENA subscription sync/cleanup functions for coordinators

- [#32](https://github.com/brew-lab/thaumic-cast/pull/32) [`7848217`](https://github.com/brew-lab/thaumic-cast/commit/784821772da8e0b1501653cd680f157d881b0a0e) Thanks [@skezo](https://github.com/skezo)! - ### Documentation
  - **Onboarding Firewall Step**: Update copy to explain mDNS multicast addresses (224._) that may appear in third-party firewalls like Little Snitch. Users were confused when seeing connections to unfamiliar 224._ addresses during speaker discovery.

- Updated dependencies [[`f633dda`](https://github.com/brew-lab/thaumic-cast/commit/f633dda4f4146a81a908c14a6b79dfc44ca6f674)]:
  - @thaumic-cast/ui@0.0.5

## 0.8.2

### Patch Changes

- Updated dependencies [[`21e4991`](https://github.com/brew-lab/thaumic-cast/commit/21e4991c5769c6d50b7cff677d05245fb6021afa)]:
  - @thaumic-cast/ui@0.0.4

## 0.8.1

### Patch Changes

- Updated dependencies [[`7af7ee1`](https://github.com/brew-lab/thaumic-cast/commit/7af7ee150acabc9812cf74bd8d1c9edd1e8edded)]:
  - @thaumic-cast/ui@0.0.3

## 0.8.0

## 0.7.0

### Minor Changes

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`ea2ed2f`](https://github.com/brew-lab/thaumic-cast/commit/ea2ed2f2102cdddd26216c963e4c0470a49c5605) Thanks [@skezo](https://github.com/skezo)! - Add multi-method Sonos speaker discovery for improved reliability
  - SSDP multicast (standard 239.255.255.250:1900)
  - SSDP broadcast (directed per-interface + 255.255.255.255 fallback)
  - mDNS/Bonjour (\_sonos.\_tcp.local.)

  All methods run in parallel and results are merged with comprehensive UUID normalization. This helps discover speakers on networks where multicast is blocked but mDNS works (common on macOS with firewall enabled).

### Patch Changes

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`01f2d22`](https://github.com/brew-lab/thaumic-cast/commit/01f2d22d14ef1a71f3b3a5c63eba10c1d67b7e4b) Thanks [@skezo](https://github.com/skezo)! - Add epoch-based latency measurement for video sync
  - Per-speaker playback epochs anchored to oldest prefill frame served
  - Emit `epochId` and `jitterMs` in latency events for extension state machine
  - Add `LatencyEvent::Stale` when no valid position data for 30s
  - TTL cleanup for epoch HashMap (max 20 entries per stream)

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`ec40759`](https://github.com/brew-lab/thaumic-cast/commit/ec407595bbf3424b3a2595f3124a49efcc05bbc1) Thanks [@skezo](https://github.com/skezo)! - Fix speaker discovery UI showing "No speakers found" prematurely during onboarding by using event-driven updates instead of timer-based polling

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`0d2d1d8`](https://github.com/brew-lab/thaumic-cast/commit/0d2d1d8a313f187bbe833ffbce710c67966aed8e) Thanks [@skezo](https://github.com/skezo)! - Add event-driven UI updates for network health and stream status, replacing polling with real-time Tauri events for more responsive speaker discovery and playback status

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`66883af`](https://github.com/brew-lab/thaumic-cast/commit/66883afd06379cec28fe6115aad8aa246a11f73c) Thanks [@skezo](https://github.com/skezo)! - Fix "launch at login" setting not persisting after app restart

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`e9d78dc`](https://github.com/brew-lab/thaumic-cast/commit/e9d78dc06f2f9c247ca904702fb29edb41039cdb) Thanks [@skezo](https://github.com/skezo)! - Fix macOS dock icon persisting after window is closed

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`bf687a6`](https://github.com/brew-lab/thaumic-cast/commit/bf687a6ad1f2b8110555f077f14b15fb0f33376b) Thanks [@skezo](https://github.com/skezo)! - Fix WAV/PCM stream stop timeout by closing HTTP connections before sending SOAP commands to Sonos

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`098bc11`](https://github.com/brew-lab/thaumic-cast/commit/098bc112946bc3a769e12ac76b2fab049a635e02) Thanks [@skezo](https://github.com/skezo)! - Redesign system tray menu with quick actions and status
  - Display app name with version and streaming status
  - Add Dashboard action to open the main window
  - Add Launch at Startup toggle for autostart control
  - Add Stop All Streams and Restart Server quick actions
  - Full i18n support with localized menu items

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`bf865cb`](https://github.com/brew-lab/thaumic-cast/commit/bf865cb344755388f2a2b7054728c9e6a5d1714b) Thanks [@skezo](https://github.com/skezo)! - Use platform-specific terminology in onboarding welcome step (menu bar on macOS, system tray on Windows/Linux)

- Updated dependencies [[`afbe950`](https://github.com/brew-lab/thaumic-cast/commit/afbe95005caa9dea84483d1fea0fe0c93e65e714)]:
  - @thaumic-cast/ui@0.0.2
  - @thaumic-cast/protocol@0.1.1

## 0.6.1

### Patch Changes

- [#19](https://github.com/brew-lab/thaumic-cast/pull/19) [`aae78f0`](https://github.com/brew-lab/thaumic-cast/commit/aae78f008ec7a019c8f312db9c288e34462e1a99) Thanks [@skezo](https://github.com/skezo)! - fix(desktop): resolve macOS "damaged app" error with ad-hoc signing
  - Add explicit ad-hoc signing identity for macOS builds
  - Set minimum macOS version to 12.0 (Monterey)
  - Add bundle metadata (category, copyright, publisher, description)

## 0.6.0

### Minor Changes

- [#17](https://github.com/brew-lab/thaumic-cast/pull/17) [`06ffe4f`](https://github.com/brew-lab/thaumic-cast/commit/06ffe4f80c6837314941d1e47115143f3bd44d2d) Thanks [@skezo](https://github.com/skezo)! - Add latency monitoring service for measuring audio playback delay
  - Add GetPositionInfo SOAP call to query Sonos playback position
  - Track stream timing via sample count for precise source position
  - Create LatencyMonitor service with high-frequency polling (100ms)
  - Calculate latency with RTT compensation and EMA smoothing
  - Emit LatencyEvent broadcasts with confidence scoring
  - Foundation for future video-to-audio sync feature

- [#17](https://github.com/brew-lab/thaumic-cast/pull/17) [`cf0b867`](https://github.com/brew-lab/thaumic-cast/commit/cf0b867942b54fd1f099d1bc031ebe1cc5f2b860) Thanks [@skezo](https://github.com/skezo)! - Add server-side WAV encoding for lossless audio streaming
  - Add "Lossless (WAV)" codec option that sends raw PCM from browser to desktop app
  - Desktop app wraps PCM in WAV container for true lossless quality
  - Works universally since PCM passthrough has no browser codec dependencies
  - Hide bitrate selector in UI for lossless codecs (no bitrate options)

### Patch Changes

- [#17](https://github.com/brew-lab/thaumic-cast/pull/17) [`ca0081e`](https://github.com/brew-lab/thaumic-cast/commit/ca0081ef4ceaaad2d3cced16a29be293bcc01e8b) Thanks [@skezo](https://github.com/skezo)! - Improve UI polish with themed scrollbars and better typography
  - Add thin themed scrollbars using `scrollbar-width: thin` and `scrollbar-color` with the primary color for a consistent, subtle appearance
  - Apply `text-wrap: balance` to headings and `text-wrap: pretty` to paragraphs for improved text layout

- Updated dependencies [[`06ffe4f`](https://github.com/brew-lab/thaumic-cast/commit/06ffe4f80c6837314941d1e47115143f3bd44d2d)]:
  - @thaumic-cast/protocol@0.1.0

## 0.5.0

### Minor Changes

- [#15](https://github.com/brew-lab/thaumic-cast/pull/15) [`f65dae0`](https://github.com/brew-lab/thaumic-cast/commit/f65dae0711e26bf2682b604474125b70dc28820e) Thanks [@skezo](https://github.com/skezo)! - ### Theme System
  - Add dark/light mode support with automatic system preference detection
  - Adopt mystical violet OKLCH color palette with semantic token layers
  - Add motion tokens with reduced-motion support

  ### Internationalization
  - Add i18n framework with English translations for desktop and extension
  - Detect system/browser language preferences automatically

  ### Multi-Group Casting
  - Add UI to select and cast to multiple Sonos speaker groups simultaneously

  ### Onboarding
  - Add first-time user onboarding wizard with platform-specific firewall instructions
  - Defer network services until firewall warning is acknowledged

  ### Network Health Monitoring
  - Detect VPN/network issues that prevent speaker communication
  - Show contextual warnings when speakers aren't responding
  - Improve error messaging for no-speakers-found state

  ### ActiveCastCard Redesign
  - Redesign with artwork background and dynamic color extraction
  - Add playback controls (play/pause, stop)
  - Add view transitions for track changes
  - Make title clickable to navigate to source tab

  ### Shared UI Components
  - Add VolumeControl with fill indicator and mute button
  - Add IconButton component
  - Add Alert component with error/warning/info variants and dismiss support

  ### Accessibility
  - Improve WCAG 2.1 AA compliance across extension UI
  - Ensure proper contrast ratios for all text elements

  ### Fixes
  - Stop speakers immediately when stream ends
  - Switch speakers to queue after stopping stream
  - Clean up existing stream when starting playback on same speaker
  - Sync transport state for stream recovery
  - Reconnect when server settings change
  - Use static branding in DIDL-Lite metadata

## 0.4.1

## 0.4.0

## 0.3.1

### Patch Changes

- [#9](https://github.com/brew-lab/thaumic-cast/pull/9) [`9751058`](https://github.com/brew-lab/thaumic-cast/commit/9751058c2b06c0e40d48e3b0aecd5cfe410be3e5) Thanks [@skezo](https://github.com/skezo)! - Fix automated release workflow
  - Change changesets config from `linked` to `fixed` to ensure both packages always version together
  - Add version mismatch detection in release-pr workflow
  - Fix missing Linux build dependencies in release workflow
  - Add `tauriScript` config for bun in tauri-action
  - Use `workflow_call` to trigger release builds automatically (no PAT required)

## 0.3.0

### Minor Changes

- [#7](https://github.com/brew-lab/thaumic-cast/pull/7) [`b354fbf`](https://github.com/brew-lab/thaumic-cast/commit/b354fbfcf4b7611042611fafa6f91d747034c321) Thanks [@skezo](https://github.com/skezo)! - Add native power state detection and battery-aware audio config
  - Desktop app now detects system power state using native OS APIs (starship-battery)
  - Power state is sent to extension via WebSocket, bypassing browser Battery API limitations
  - Extension automatically selects lower-quality audio config when on battery to prevent audio dropouts
  - Added audio pipeline monitoring to detect silent failures and source starvation
  - Session health tracking reports audio drops for config learning

## 0.1.1

### Patch Changes

- [#2](https://github.com/brew-lab/thaumic-cast/pull/2) [`e9169f5`](https://github.com/brew-lab/thaumic-cast/commit/e9169f5094b25262f7f376b82954d46160ca9f40) Thanks [@skezo](https://github.com/skezo)! - Fix runtime errors and audio streaming issues
  - Fix nested anchor tags in Sidebar causing "improper nesting of interactive content" warnings
  - Fix TypeScript types to match Rust backend ZoneGroup structure
  - Fix undefined coordinator access causing infinite re-render loop
  - Fix AudioWorkletNode not connected to audio graph, preventing audio capture
  - Fix codec mismatch in WebSocket handshake causing wrong Content-Type for Sonos
  - Fix XML escaping in SOAP/DIDL to escape all 5 XML special characters (was missing " and ')
