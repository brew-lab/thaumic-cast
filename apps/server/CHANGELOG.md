# @thaumic-cast/server

## 0.12.1

### Patch Changes

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

- [#201](https://github.com/brew-lab/thaumic-cast/pull/201) [`a5c6cc8`](https://github.com/brew-lab/thaumic-cast/commit/a5c6cc84a7fdd9afb2690c0e723a83003ff9d9f4) Thanks [@skezo](https://github.com/skezo)! - docs(server): rewrite the README and the server's README

  The project README and the server's README, which ships in the release tarball, have been rewritten in the same words
  the apps now use: cast, speaker head start, reserve, speaker monitoring, clock drift correction. Commands, options and
  defaults are unchanged, and so are the tables, apart from a few descriptions that now use those words. The server's
  README now gives the extension's settings path as it appears on screen (Settings → Companion → Enter the address), says
  that adding a speaker by IP address needs `data_dir`, and lists what the server actually does when it is asked to
  stop.

- [#200](https://github.com/brew-lab/thaumic-cast/pull/200) [`d6b5319`](https://github.com/brew-lab/thaumic-cast/commit/d6b5319c8bc7aed4ea1729bd58709db3d4587c56) Thanks [@skezo](https://github.com/skezo)! - feat(server): rewrite the help text, the startup lines and the configuration errors

  `thaumic-server --help` and the lines the server prints as it starts and stops have been rewritten. Each flag now says
  what it is for in the words the apps use (speaker head start, speaker monitoring, clock drift correction), and a
  configuration error says which value is wrong and what it may be. Flag names, environment variables, config keys and
  defaults are unchanged. The startup line that said manual speakers "will not persist" without a data directory now
  says what actually happens: speakers cannot be added by IP address until one is set.

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

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`921110c`](https://github.com/brew-lab/thaumic-cast/commit/921110c2c05b2d2af9689de4d10279848e4d538d) Thanks [@skezo](https://github.com/skezo)! - fix(server): exit with an error when the HTTP server cannot start

  A failed port bind was only logged inside the spawned task. The process then reported that the server had started and
  waited on the shutdown signal forever, so a service manager saw a healthy unit and never restarted it. Startup now
  fails properly and the process exits with a non-zero status.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`921110c`](https://github.com/brew-lab/thaumic-cast/commit/921110c2c05b2d2af9689de4d10279848e4d538d) Thanks [@skezo](https://github.com/skezo)! - fix(server): validate configuration instead of failing later

  A topology refresh interval of zero was accepted and then panicked inside a background task, aborting the release
  binary and leaving a service manager to restart it repeatedly with an unhelpful message. Configuration is now checked
  at load with a clear error, the monitor clamps the interval defensively, and environment variables are read in one
  place so an invalid value is reported rather than ignored.

- [#134](https://github.com/brew-lab/thaumic-cast/pull/134) [`b70fde3`](https://github.com/brew-lab/thaumic-cast/commit/b70fde3ae3ae1b5af9e41f6bdeb92a63b5079db3) Thanks [@skezo](https://github.com/skezo)! - feat(server): one-command install, update and Proxmox setup

  Releases now include `thaumic-server-vX.Y.Z-linux-{x64,arm64}.tar.gz` with checksums, a hardened systemd unit and
  `install.sh`. The installer (`curl … | sudo bash`) installs or updates in place, verifies checksums and only ever
  contacts GitHub releases. `proxmox-lxc.sh` creates an unprivileged Debian 12 container on a Proxmox host and runs the
  installer inside it. Added `apps/server/Dockerfile`, refreshed the README (Proxmox guide, network requirements,
  correct Rust version) and made the release version sync refresh `Cargo.lock` so `cargo build --locked` passes after a
  release.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`3a2a48a`](https://github.com/brew-lab/thaumic-cast/commit/3a2a48acdb211d3aa0f3d11f45069f79163ce1ca) Thanks [@skezo](https://github.com/skezo)! - docs(server): document speaker monitoring and the head start

  The example config the installer copies now spells out `speaker_monitor: true` and `pcm_connect_burst_ms: 500`, the
  defaults (so new installs pin them in `/etc/thaumic-server/config.yaml`, and a later change to the shipped defaults will
  not reach those installs), and describes them the way the apps do: the speaker monitor is what drives the speaker
  notices clients show, and the speaker head start (0 to 2000 ms) is audio each speaker gets at once when it connects to a
  PCM cast, which helps one speaker on a weak Wi-Fi link and adds that much delay; every speaker cutting out at once needs
  more smoothing in the browser extension instead. The README's option and environment tables add `--speaker-monitor`,
  `--pcm-connect-burst-ms` and `--strict-stream-access` with their `THAUMIC_*` variables, noting that the speaker monitor
  and head start variables outrank the flags, and tests check that the example config parses to the shipped defaults and
  sets both speaker keys.

- [#134](https://github.com/brew-lab/thaumic-cast/pull/134) [`bffd1da`](https://github.com/brew-lab/thaumic-cast/commit/bffd1dac35de6af3ec0c1f9bdf7a2287afdcf741) Thanks [@skezo](https://github.com/skezo)! - fix(server): stop panicking at startup and serve audio on the streaming runtime

  `thaumic-server` aborted immediately with "Cannot block the current thread from within a runtime" because the
  streaming runtime blocked on a channel from inside `#[tokio::main]`. The runtime is now built on the calling thread
  and handed to a keeper thread, so nothing blocks and it can be created from any context. The server also serves
  HTTP on that runtime, as the desktop app does, so its priority-elevated workers carry the audio path instead of
  sitting idle.

- [#217](https://github.com/brew-lab/thaumic-cast/pull/217) [`46e2827`](https://github.com/brew-lab/thaumic-cast/commit/46e28275dbebda627eeb03846a00a4767396358f) Thanks [@skezo](https://github.com/skezo)! - refactor(core,server): move the speaker monitor loop into its module and name it SpeakerMonitor

  An internal restructuring with no behaviour change. The polling loop that watches speakers lived in
  `services/latency_monitor.rs` under the name `LatencyMonitor`, apart from the rest of the speaker monitor. It is now
  `services/speaker_monitor/monitor.rs` and the type is `SpeakerMonitor`. Settings, environment variables, events and
  the text of every log line are the same.

  One thing differs in the logs: lines emitted from this file now print the module path
  `thaumic_core::services::speaker_monitor::monitor` instead of `thaumic_core::services::latency_monitor`. A grep or a
  log-level filter on the module path needs updating; a grep on `[SpeakerMonitor]` does not.

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

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`f760cf6`](https://github.com/brew-lab/thaumic-cast/commit/f760cf667b511e5bae7458d8eeb9875920fb9659) Thanks [@skezo](https://github.com/skezo)! - fix(core): advertise the speakers' LAN address from the first discovery

  At launch nothing has been discovered, so the advertised address is chosen from the interface list alone, and on a
  machine whose default route runs through a VPN adapter the name filter does not recognise (Cloudflare WARP on Windows)
  it is the tunnel's. Detection only ran again at the top of the next refresh, so the first round of GENA subscriptions,
  and any cast started in the meantime, were built on an address no speaker could reach. Detection now re-runs against
  the speakers as soon as discovery finds them, before the groups are published or anything is subscribed. Playback
  also moves the address onto the target speakers' subnet when it is on none of them and a detected address is, and a
  SUBSCRIBE rejected with 412 is retried once with a corrected callback. An explicitly configured address is never
  changed, and with no speakers known the launch choice is unchanged.

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

## 0.12.0

### Minor Changes

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

- [#107](https://github.com/brew-lab/thaumic-cast/pull/107) [`b73b49e`](https://github.com/brew-lab/thaumic-cast/commit/b73b49ea5b15d115cb016f395074891c7f77cc95) Thanks [@skezo](https://github.com/skezo)! - Polish the companion version-mismatch surface introduced in the previous release, and unblock the path that was supposed to surface it for older companions.
  - Accept `INITIAL_STATE` payloads that omit `groupVolumeFixed`. That field was added after the initial protocol shipped; older companions don't send it, so the extension's `WS_CONNECTED` route rejected their messages at schema validation — `handleWsConnected` never ran, the popup stayed stuck at "Checking…", and the out-of-date warning (the very UI meant for this scenario) never had a chance to render. The `groupVolumeFixed` field now defaults to an empty map when missing, so older-companion payloads validate and the version-mismatch flow fires as designed.
  - Prevent the out-of-date warning Alert from briefly flashing on every initial connection. The popup was flipping `phase` to `'connected'` optimistically on `WS_STATE_CHANGED` before the async fetch that carries the companion metadata resolved, so `protocolVersion` was transiently `null` and the mismatch helper would light up the Alert for a single render. The connection-status hook now only transitions to `'connected'` via the metadata-bearing `CACHED_STATE_RECEIVED`, applying phase and metadata atomically. The companion-version hook additionally gates on `phase === 'connected'` so no flash window can open between discovery and WebSocket `INITIAL_STATE`.
  - Gate the Alert on the persisted dismissal record having loaded, closing a smaller race where a previously-dismissed warning briefly reappeared on popup open before `chrome.storage.local` resolved.
  - Rename the protocol line in the extension About card and the desktop Settings About card from `Protocol v{{version}}` to `Protocol · Version {{version}}`, matching the adjacent `Desktop App · Version {{version}}` / `Version {{version}}` format.

## 0.11.0

## 0.2.0

### Minor Changes

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

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`2109faf`](https://github.com/brew-lab/thaumic-cast/commit/2109faf6fa40452a56789ddd08f22ccf08d884bb) Thanks [@skezo](https://github.com/skezo)! - Introduce standalone headless server

  **New Application**

  Add `apps/server` - a headless Thaumic Cast server that runs without a GUI. Built on thaumic-core, it provides the same streaming capabilities as the desktop app for server/NAS deployments.

  **Features**
  - YAML configuration file support (`config.yaml`)
  - CLI arguments for host, port, data directory
  - Environment variable overrides (`THAUMIC_HOST`, `THAUMIC_PORT`, etc.)
  - Graceful shutdown on SIGINT/SIGTERM
  - Optional data persistence directory for manual speakers

  **Configuration Precedence**

  CLI args > Environment variables > Config file > Defaults

  **Usage**

  ```bash
  # With config file
  thaumic-server --config config.yaml

  # With CLI args
  thaumic-server --host 0.0.0.0 --port 9876

  # With environment
  THAUMIC_PORT=9876 thaumic-server
  ```
