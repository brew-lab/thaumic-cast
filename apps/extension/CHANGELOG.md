# @thaumic-cast/extension

## 0.12.1

### Patch Changes

- [#190](https://github.com/brew-lab/thaumic-cast/pull/190) [`1934229`](https://github.com/brew-lab/thaumic-cast/commit/1934229e472080dffc758b35da25b176096822fe) Thanks [@skezo](https://github.com/skezo)! - fix(extension): label AAC streams as AAC-LC, not AAC Main

  Every AAC frame the extension sends carries a small header that tells the speaker what kind of AAC follows. That
  header named the wrong kind: AAC-LC audio was labelled AAC Main, and the HE-AAC options were labelled AAC-LTP. All AAC
  options are now labelled AAC-LC at the stream's own sample rate and channels, because that is what the browser encodes
  for every one of them: measured on Chrome and Edge on Windows, the HE-AAC and HE-AAC v2 options produce exactly the
  same audio as AAC-LC at the same bitrate. How the speakers treated the old labels has not been measured.

- [#206](https://github.com/brew-lab/thaumic-cast/pull/206) [`820501c`](https://github.com/brew-lab/thaumic-cast/commit/820501c0a0fe5f4ff2e06c066d9d3866652e2b4a) Thanks [@skezo](https://github.com/skezo)! - fix(extension): show each audio setting only where it does something

  The Audio settings now show a control only for casts it affects. With browser-wide capture on, casts go out
  as PCM whatever Quality is chosen, and the page now says so; the choice is kept for when browser-wide capture is off.
  Smoothing is shown for every PCM cast, which includes any cast under browser-wide capture: it was hidden there with a
  compressed Quality while still being applied, and the popup's link to it led nowhere. Frame size is hidden under
  browser-wide capture, where it is fixed at 10 ms; the stored value is kept. Bit depth appears only for FLAC, the one
  codec with more than one. When the browser will not encode the exact codec, bitrate, sample rate and channels a
  Quality or a Bespoke choice asks for, the page says so there, instead of the cast failing to start. No stored setting
  or default has changed, and a tab cast sends what it sent before.

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

- [#193](https://github.com/brew-lab/thaumic-cast/pull/193) [`644a955`](https://github.com/brew-lab/thaumic-cast/commit/644a955100483f155176286cf74fa0bb2627a400) Thanks [@skezo](https://github.com/skezo)! - fix(core): stop reporting a compressed cast's speaker as still locking

  A speaker's buffer can only be measured on a PCM stream. For AAC and FLAC the companion nevertheless reported the speaker
  as "locking" (still measuring) for the whole cast, as if a reading were on its way. It now reports "unmeasured" for those
  streams, in its log and to the extension and desktop app, and still says when such a speaker is paused, not answering or
  playing something else. PCM casts are reported exactly as before.

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

- [#198](https://github.com/brew-lab/thaumic-cast/pull/198) [`eae2ba8`](https://github.com/brew-lab/thaumic-cast/commit/eae2ba81c0347572af5f20842f8b3929ea39e233) Thanks [@skezo](https://github.com/skezo)! - feat(extension): rewrite the popup, its errors and the first-run tour

  The extension's popup, error messages and first-run tour have been rewritten. The button that ends a cast says "Stop",
  the heading over running casts says "Casting now", and an error now says what happened and what to do about it, such
  as "Nothing answered. Thaumic Cast needs the desktop app or a server running to reach the speakers; start one, then
  try again." When a cast stops by itself the reason names the speaker where one was involved. The settings page is unchanged.

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

- [#212](https://github.com/brew-lab/thaumic-cast/pull/212) [`dd1bf05`](https://github.com/brew-lab/thaumic-cast/commit/dd1bf057cdffa6806ee3bad2fc55a4e5c3843564) Thanks [@skezo](https://github.com/skezo)! - refactor(extension,protocol): stop sending fields the companion never reads, and remove reconfigure()

  Internal tidying; nothing a listener can see or hear changes. When a cast starts, the extension no longer sends the
  companion its frame duration and latency mode. The companion reads neither: it works the frame duration out from the
  frame size, and the latency mode only steers the extension's own encoder. Both settings are stored and used in the
  extension as before. An encoder method that nothing called is gone. New tests hold the extension and the companion to
  the same smoothing, frame duration and speaker head start limits, and to the same handshake.

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

- [#136](https://github.com/brew-lab/thaumic-cast/pull/136) [`bb3da36`](https://github.com/brew-lab/thaumic-cast/commit/bb3da36f91ad14ad55e23e5f35bddd419146cf04) Thanks [@skezo](https://github.com/skezo)! - feat(extension): ask for permission to reach a companion on another machine

  When you enter a custom server URL and click Connect (previously "Test"), Chrome now prompts once to allow that address, scoped to that
  origin only. This replaces the companion's CORS layer, which trusted every installed browser extension and wrapped the
  API in middleware; the HTTP API no longer sends CORS headers.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`921110c`](https://github.com/brew-lab/thaumic-cast/commit/921110c2c05b2d2af9689de4d10279848e4d538d) Thanks [@skezo](https://github.com/skezo)! - fix(extension): keep audio frames in order when the connection is congested

  In quality mode a newly encoded frame was sent as soon as the socket drained, even while older frames were still
  queued, so the server could receive audio out of order. Queued frames are now always drained first, including for the
  underflow ramp and the final flush at the end of a cast. Realtime mode is unchanged.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`921110c`](https://github.com/brew-lab/thaumic-cast/commit/921110c2c05b2d2af9689de4d10279848e4d538d) Thanks [@skezo](https://github.com/skezo)! - fix(extension): send each speaker command once and clean up slow cast starts

  Volume and mute changes from the popup reached both the background worker and the audio document, so each command was
  sent to the server twice. Messages intended for the audio document now carry a marker and anything else is ignored.
  A cast start that took longer than the background timeout also left the tab captured and the speakers playing with no
  session to stop; long operations now get a longer timeout and the failure path stops the session.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`921110c`](https://github.com/brew-lab/thaumic-cast/commit/921110c2c05b2d2af9689de4d10279848e4d538d) Thanks [@skezo](https://github.com/skezo)! - fix(extension): keep valid settings when one stored value fails validation

  Settings were validated as a whole, so a single value left over from an older build made the loader return defaults
  and the next save persist them, discarding the server address, theme and audio mode. Each field is now validated on
  its own and only invalid ones fall back, with the discarded names logged.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`a079ad9`](https://github.com/brew-lab/thaumic-cast/commit/a079ad9f678a2ad25553e0d0b6c3c90e427989da) Thanks [@skezo](https://github.com/skezo)! - feat(extension): recast PCM audio options around smoothing

  The network buffer is now called smoothing, which is what it does: the Thaumic Cast desktop app or server holds that
  much audio back to even out how it arrives from this browser. It does nothing for a speaker's own Wi-Fi, which the
  speaker head start covers, and a companion on the same machine gains nothing from more of it; the notice about audio
  arriving late says when more would help. Smoothing (100, 200, 300 or 500 ms) and frame size are now standalone PCM
  settings under Audio > Advanced, shown in every mode rather than only in Bespoke, and the quality mode no longer
  changes them. Existing settings move over once: a Bespoke value is kept, snapped to the nearest step (1000 ms becomes
  500 ms); the Luxurious and Sensible presets, which ran with 500 ms, move to 300 ms; and Economical keeps 200 ms. When
  the value changes, the options page says so once. For PCM, the sample rate select is gone, since PCM always goes out
  at the rate the browser captures, and the summary reads "Matches the audio device". It also shows the speaker head
  start the desktop app or server sends and the delay smoothing and head start add together. The protocol gains the
  smoothing default and steps, and the streaming policy no longer carries a jitter buffer. The onboarding note on
  expectations now says audio reaches the speakers about a second after the browser plays it.

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

- [#204](https://github.com/brew-lab/thaumic-cast/pull/204) [`47be5af`](https://github.com/brew-lab/thaumic-cast/commit/47be5afce9f53ddc4a1b72a0adf66d0ced48b15d) Thanks [@skezo](https://github.com/skezo)! - fix(extension): a mono PCM cast carries both channels

  A mono PCM cast now carries both channels mixed together; it used to carry the left one only, so anything that was
  only in the right channel went missing. Stereo casts are unchanged.

  The log now records, once per PCM cast, the sample rate the capture delivers beside the rate the cast declared, and
  warns when the two differ.

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

- [#209](https://github.com/brew-lab/thaumic-cast/pull/209) [`6a5f60c`](https://github.com/brew-lab/thaumic-cast/commit/6a5f60cfcfcbaf3fab0a01e37a2186e76e7fe993) Thanks [@skezo](https://github.com/skezo)! - feat(extension,desktop): hide the language pickers until there is a second language

  The Language section in the extension's options and in the desktop app's Settings offered one choice, English. Both are
  now hidden, and come back by themselves when a second language ships. Nothing else on either page moves.

  The extension used to store English as your language even though you never picked it, which would have kept you on
  English after a translation for your browser's language arrived. The stored language can now be "auto", meaning follow
  the browser, and that is the default. A stored English is changed to "auto" once, when this version first loads the
  settings. After that, English picked in the Language section is your choice and is kept. Every other setting is
  unchanged.

- [#208](https://github.com/brew-lab/thaumic-cast/pull/208) [`7107f8e`](https://github.com/brew-lab/thaumic-cast/commit/7107f8e50e39410087c411b6262ba8c846f062e4) Thanks [@skezo](https://github.com/skezo)! - feat(extension): show the fall-behind setting for PCM and reset a stale hidden value once

  "Latency Mode" is now "When the connection falls behind", and its two choices say what they do: "Let delay grow (up to
  a limit)" and "Skip ahead (brief gaps)". The setting used to be shown only for AAC and FLAC, but a Bespoke PCM cast
  obeyed it too, so anyone who had picked the second choice for AAC and then moved to PCM was skipping audio with no
  control on the page to say so. It now appears under Advanced for Bespoke PCM. Because nobody could have chosen it for
  PCM before, a stored "Skip ahead" on Bespoke PCM is set back to "Let delay grow" once, when this version first loads
  the settings. After that the choice is yours and is kept. The presets and every other setting are unchanged.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`c219d46`](https://github.com/brew-lab/thaumic-cast/commit/c219d4693303063d6934d3cec8d28d20b980b97e) Thanks [@skezo](https://github.com/skezo)! - feat(extension): show speaker notices instead of buffer advice

  The popup warned when the path to a speaker was unstable and told the user to raise the network buffer, which cannot
  help: that buffer only evens out how audio reaches the desktop app or server, not how it reaches the speaker. The
  link-quality warning is gone. The popup now shows the notice the companion decided on for each speaker it is casting
  to, worded for where the fix lives: a Wi-Fi stall that outlasted the speaker head start (or nearly did) says how much
  audio it held back and which head start would have covered it, then where to change it: the desktop app's Settings >
  Speakers, `pcm_connect_burst_ms` in the server's config, or the environment variable that fixes it; a stall no head
  start covers suggests moving the speaker or using Ethernet; a speaker running low or being drained by its clock says
  so, with restart advice only when a restart would refill it. A dismissed notice stays dismissed while the companion
  repeats it and returns only as a new episode or an escalation, and dismissed head-start advice for a speaker is
  remembered for 24 hours, so the next cast does not repeat it unless the advice goes higher. Separately, when audio
  from the browser reached the companion late often enough to give every speaker a gap, the popup says so and suggests
  the smoothing step that would cover it, with a shortcut to the audio settings, unless the capture-health warning
  already explains it. The extension keeps the companion's speaker head start and speaker monitor settings current for
  this wording. The protocol drops the retired link-quality event and the time to empty, and the shared Alert takes a
  translated label for its dismiss button.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`602c9ee`](https://github.com/brew-lab/thaumic-cast/commit/602c9ee2ff71b41f4added085bda4a48c1d1154c) Thanks [@skezo](https://github.com/skezo)! - feat(protocol): say when another client takes a speaker, and show speakers in use

  Taking a speaker from another client sent a stop with no reason, so the other person saw a generic message. A distinct
  reason is now sent and shown. The extension also never read the session list the server provides, so availability came
  only from that browser's own casts and the automatic choice was always the first group alphabetically, meaning several
  machines defaulted to the same speaker and each showed it as free. Speakers in use by another client are now a
  separate state, skipped when choosing automatically and still selectable deliberately, and the concurrent stream count
  comes from the server rather than one browser's view.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`66f7a0a`](https://github.com/brew-lab/thaumic-cast/commit/66f7a0a91318092354709a5794c3b8b928487b40) Thanks [@skezo](https://github.com/skezo)! - fix(extension): ignore topology event types this build does not use

  The companion now sends a memberChanged topology event when a satellite drops off or a device reboots. The extension
  validated every topology event as a group discovery, so each new one failed validation and logged an error. Topology
  events of other types are now accepted and ignored at debug level, as network events already were.

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`921110c`](https://github.com/brew-lab/thaumic-cast/commit/921110c2c05b2d2af9689de4d10279848e4d538d) Thanks [@skezo](https://github.com/skezo)! - fix(extension): apply the video sync offset and stop the loop fighting itself

  The offset slider was stored but never used in the delay calculation. The sync loop's own seeks and pauses also
  triggered the handlers that drop the lock, so it re-acquired repeatedly, and alignment could start again while a
  previous one was still waiting. Programmatic adjustments are now recognised and ignored, with a seek matched against
  where the video actually landed so a real seek by the viewer is still honoured, and alignment cannot overlap.

  Known limitation: on sites that override playback rate, where the extension falls back to brief pauses, an offset
  change that needs the video to move forward is not applied to a running lock and takes effect at the next re-sync.

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

- [#108](https://github.com/brew-lab/thaumic-cast/pull/108) [`94a7134`](https://github.com/brew-lab/thaumic-cast/commit/94a71347f1d3b689568e65339919a932d1955970) Thanks [@skezo](https://github.com/skezo)! - Detect Chrome LoopbackStream frame drops and suggest WASAPI browser capture

  Adds an edge-triggered capture-health detector to `StreamSession` that watches `AudioData` timestamp gaps. On low-core Windows devices Chrome's LoopbackStream drops whole audio frames (~9 ms each), which is audible as stuttering; sustained detection surfaces a dismissible popup alert pointing the user at Advanced settings to enable Browser-wide capture, which bypasses LoopbackStream entirely. Degradation and recovery both flow through a new `CAPTURE_HEALTH_EVENT` → `CAPTURE_HEALTH_CHANGED` broadcast modelled on the existing network-health pipeline.

  Detection is currently limited to the tab-capture + PCM path (the only worker that emits `gapCount`). Parity for Opus/AAC/FLAC/Vorbis is tracked as follow-up work.

- [#71](https://github.com/brew-lab/thaumic-cast/pull/71) [`a01a1c4`](https://github.com/brew-lab/thaumic-cast/commit/a01a1c4bd61ff52bddb5d244ca8361fd0a127351) Thanks [@skezo](https://github.com/skezo)! - Add fixed volume detection for Sonos speakers with line-level output

  Sonos devices like CONNECT and Port have fixed line-level output where volume cannot be adjusted via API. This change detects and handles these speakers:
  - Parse `OutputFixed` from GENA GroupRenderingControl notifications
  - Propagate `fixed` state through the event system alongside volume updates
  - Disable volume controls in the UI for fixed-output speakers
  - Add `disabled` prop to `VolumeControl` and `SpeakerVolumeRow` components

  When a speaker has fixed volume, the volume slider and mute button are visually disabled and non-interactive.

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

- [#96](https://github.com/brew-lab/thaumic-cast/pull/96) [`a1d2ac2`](https://github.com/brew-lab/thaumic-cast/commit/a1d2ac261baadded34d964cecd7e4316222ec04b) Thanks [@skezo](https://github.com/skezo)! - Add MSTP audio pipeline for PCM streaming to eliminate crackling artifacts

  The previous PCM path routed captured audio through `AudioContext` + `AudioWorklet` + `SharedArrayBuffer`, which crosses a clock domain between the MediaStream and AudioContext clocks. When the two clocks drifted, the worklet would emit zero-filled audio blocks, producing audible crackling.

  This replaces the PCM path with a `MediaStreamTrackProcessor` (MSTP) pipeline that reads `AudioData` at the MediaStream's native rate — no clock crossing, no zero-fills. Compressed codecs continue to use the existing AudioContext path because their encoders run in the worklet.

  **New:**
  - `audio-relay.worker.ts`: purpose-built worker that consumes the transferred `ReadableStream<AudioData>`, extracts f32-planar channels, interleaves with TPDF dither, quantizes to Int16, and sends fixed-size frames over WebSocket.
  - `keepTabAudible` in MSTP mode uses a low-volume `<audio>` element instead of an AudioContext gain node to avoid reintroducing the clock crossing.

  **Supporting refactors:**
  - Extracted `worker-base.ts` from `audio-consumer.worker.ts` — shared WebSocket lifecycle, frame queue, backpressure handling, stats/metrics timeline, and common message handling are now reusable across consumer worker implementations.
  - Added `MetricSnapshot` + `WorkerMetricsDumpMessage` for post-session analysis.
  - Tightened encoder interface and worker frame-queue types to `Uint8Array<ArrayBuffer>` so encoded audio flows to `WebSocket.send()` without casts (required by TypeScript 5.7+).
  - Audio relay accumulator now owns its backing `ArrayBuffer` explicitly, matching the PCM encoder pattern and eliminating the last inline cast in the hot path.

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

- [#70](https://github.com/brew-lab/thaumic-cast/pull/70) [`48c068f`](https://github.com/brew-lab/thaumic-cast/commit/48c068f1fd3751fa6796997229692167913ba68a) Thanks [@skezo](https://github.com/skezo)! - Refactor connection status handling for better separation of concerns

  **Extension changes:**
  - Refactor `useConnectionStatus` hook to use reducer pattern for explicit state transitions
  - Remove i18n translation from hook; return error keys for component-level translation
  - Separate `WS_STATE_CHANGED` to only carry Sonos state (not connection metadata)
  - Add `CONNECTION_ATTEMPT_FAILED` message for explicit connection error handling
  - Replace `connected`/`checking` booleans with `phase` enum (`checking`, `reconnecting`, `connected`, `error`)
  - Add `canRetry` flag and `retry()` function to connection status
  - Add reconnecting state with user feedback when connection is temporarily lost
  - Fix race condition where WebSocket connects before `ENSURE_CONNECTION` response arrives

  **UI changes:**
  - Add inline action button support to Alert component (`action` and `onAction` props)

- [#97](https://github.com/brew-lab/thaumic-cast/pull/97) [`963170d`](https://github.com/brew-lab/thaumic-cast/commit/963170df0109686df84f47e998b63a1ffb7de6d8) Thanks [@skezo](https://github.com/skezo)! - Bump dev and production dependencies to current major versions: typescript 6, vite 8, i18next 26, react-i18next 17, lucide-preact 1, @changesets/changelog-github 0.6. Adds an `ImportMeta.env` ambient declaration in `@thaumic-cast/shared` so `logger.ts` continues to typecheck under TypeScript 6, and adds `typescript` as a direct devDependency of `@thaumic-cast/extension` so `tsc` resolves locally now that typescript-eslint pins TS 5 and prevents root hoisting.

- [#102](https://github.com/brew-lab/thaumic-cast/pull/102) [`6278e96`](https://github.com/brew-lab/thaumic-cast/commit/6278e96b51cefb87a87aeeed3279d72e8ccb1e9c) Thanks [@skezo](https://github.com/skezo)! - Eliminate scheduling bottleneck in the FLAC consumer worker drain loop

  Removes the 4ms `PROCESS_BUDGET_MS` time cap so the consumer drains every available ring-buffer sample per scheduling slot. On thermally-throttled devices where Chrome reschedules the worker with 100-280ms gaps, the old cap caused a compounding throughput deficit (~12% frame loss on 2-core targets). Adds a matching forward clamp on `nextFrameDueTime` so burst-processed audio time does not register as "ahead of schedule" and yield away the benefit.

  Only affects compressed codec paths that still run through `audio-consumer.worker` (FLAC). The PCM-via-MSTP path uses `audio-relay.worker` and is unaffected.

- [#100](https://github.com/brew-lab/thaumic-cast/pull/100) [`cc4c0a2`](https://github.com/brew-lab/thaumic-cast/commit/cc4c0a2561228940f78e6269a399be77ef660b49) Thanks [@skezo](https://github.com/skezo)! - Default `keepTabAudible` on and declare AUDIO_PLAYBACK intent for the offscreen document

  Flips the `keepTabAudible` setting default from `false` to `true` so Chrome treats the offscreen document as an active audio page, preventing AudioContext suspension and aggressive timer throttling on constrained devices. Also adds `chrome.offscreen.Reason.AUDIO_PLAYBACK` alongside `USER_MEDIA` so the offscreen document's lifecycle intent matches what it actually does.

  Users who had previously toggled this setting off manually will keep their preference (only the default changes).

- [#107](https://github.com/brew-lab/thaumic-cast/pull/107) [`b73b49e`](https://github.com/brew-lab/thaumic-cast/commit/b73b49ea5b15d115cb016f395074891c7f77cc95) Thanks [@skezo](https://github.com/skezo)! - Polish the companion version-mismatch surface introduced in the previous release, and unblock the path that was supposed to surface it for older companions.
  - Accept `INITIAL_STATE` payloads that omit `groupVolumeFixed`. That field was added after the initial protocol shipped; older companions don't send it, so the extension's `WS_CONNECTED` route rejected their messages at schema validation — `handleWsConnected` never ran, the popup stayed stuck at "Checking…", and the out-of-date warning (the very UI meant for this scenario) never had a chance to render. The `groupVolumeFixed` field now defaults to an empty map when missing, so older-companion payloads validate and the version-mismatch flow fires as designed.
  - Prevent the out-of-date warning Alert from briefly flashing on every initial connection. The popup was flipping `phase` to `'connected'` optimistically on `WS_STATE_CHANGED` before the async fetch that carries the companion metadata resolved, so `protocolVersion` was transiently `null` and the mismatch helper would light up the Alert for a single render. The connection-status hook now only transitions to `'connected'` via the metadata-bearing `CACHED_STATE_RECEIVED`, applying phase and metadata atomically. The companion-version hook additionally gates on `phase === 'connected'` so no flash window can open between discovery and WebSocket `INITIAL_STATE`.
  - Gate the Alert on the persisted dismissal record having loaded, closing a smaller race where a previously-dismissed warning briefly reappeared on popup open before `chrome.storage.local` resolved.
  - Rename the protocol line in the extension About card and the desktop Settings About card from `Protocol v{{version}}` to `Protocol · Version {{version}}`, matching the adjacent `Desktop App · Version {{version}}` / `Version {{version}}` format.

- [#104](https://github.com/brew-lab/thaumic-cast/pull/104) [`addbb4a`](https://github.com/brew-lab/thaumic-cast/commit/addbb4af190bec5298156449ddad561c61dd9c35) Thanks [@skezo](https://github.com/skezo)! - Bump `@preact/preset-vite` to 2.10.5 and `@crxjs/vite-plugin` to 2.4.0 to silence Vite 8 deprecation warnings — `vite:preact-jsx`, `crx:content-scripts`, and `crx:web-accessible-resources` no longer set the deprecated `esbuild` option. The `rollupOptions`/`rolldownOptions` conflict from `crx:content-scripts` remains and is tracked upstream as crxjs/chrome-extension-tools#1145.

- [#98](https://github.com/brew-lab/thaumic-cast/pull/98) [`c377372`](https://github.com/brew-lab/thaumic-cast/commit/c377372324dee2ad56d65e406de0b61fffa11692) Thanks [@skezo](https://github.com/skezo)! - Fix "Session init timed out" when casting with WASAPI browser capture and the PCM codec

  After the MSTP PCM pipeline landed, `startWorker()` selected the worker purely by codec: PCM → `audio-relay.worker.ts`, everything else → `audio-consumer.worker.ts`. But `audio-relay.worker.ts` only knows how to consume a transferred `ReadableStream<AudioData>` from `MediaStreamTrackProcessor` — it has no handler for `INIT_BROWSER_CAPTURE`. So when a user enabled WASAPI browser-wide capture with the PCM codec, the offscreen document spawned the MSTP worker, posted `INIT_BROWSER_CAPTURE`, and the message was silently dropped. The WebSocket never opened, the connection promise never resolved, and init timed out.

  Worker selection now mirrors the capture-mode branching already present further down in `startWorker()`: the MSTP relay is used only for `captureMode === 'tab'` + PCM, and `audio-consumer.worker.ts` handles all browser-capture sessions regardless of codec. The latter already implements the WS-lifecycle-only browser-capture path, so no worker logic needs to move.

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

- Updated dependencies [[`48c068f`](https://github.com/brew-lab/thaumic-cast/commit/48c068f1fd3751fa6796997229692167913ba68a), [`77a19e2`](https://github.com/brew-lab/thaumic-cast/commit/77a19e21150e6b7cd35af44fb3bd6d47edc4d636), [`963170d`](https://github.com/brew-lab/thaumic-cast/commit/963170df0109686df84f47e998b63a1ffb7de6d8), [`b73b49e`](https://github.com/brew-lab/thaumic-cast/commit/b73b49ea5b15d115cb016f395074891c7f77cc95), [`a01a1c4`](https://github.com/brew-lab/thaumic-cast/commit/a01a1c4bd61ff52bddb5d244ca8361fd0a127351), [`153a447`](https://github.com/brew-lab/thaumic-cast/commit/153a44754061c3d57d101d227d4654a863f201d9), [`32ae247`](https://github.com/brew-lab/thaumic-cast/commit/32ae2471d81ace318b32080badceb578b8019ae5), [`f958485`](https://github.com/brew-lab/thaumic-cast/commit/f9584852e7e2649435ff231d01352195c65c59d9), [`facd9e8`](https://github.com/brew-lab/thaumic-cast/commit/facd9e8d5814807947193c2fd8e80b566223bb38)]:
  - @thaumic-cast/ui@3.0.0
  - @thaumic-cast/protocol@0.5.0
  - @thaumic-cast/shared@0.1.0

## 0.11.0

### Minor Changes

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

### Patch Changes

- [#59](https://github.com/brew-lab/thaumic-cast/pull/59) [`6ab489e`](https://github.com/brew-lab/thaumic-cast/commit/6ab489e2b6857ce5b22618bd07509dd6a2ecb06b) Thanks [@skezo](https://github.com/skezo)! - fix(extension): improve server URL settings behavior
  - Sync URL input with settings when changed externally
  - Auto-save and test server URL on blur (skip if clicking test button)
  - Allow clearing server URL by emptying the input
  - Normalize UI state on load: if manual mode has no URL, show auto-discover (not persisted to avoid storage listener triggers during editing)

- [#51](https://github.com/brew-lab/thaumic-cast/pull/51) [`0a194c2`](https://github.com/brew-lab/thaumic-cast/commit/0a194c21329e7b4acdbb517133d82a21340d5bf3) Thanks [@skezo](https://github.com/skezo)! - Bump JavaScript and Rust dependencies

- [#65](https://github.com/brew-lab/thaumic-cast/pull/65) [`5532946`](https://github.com/brew-lab/thaumic-cast/commit/553294669c6a086a134546e888eba9475469f32a) Thanks [@skezo](https://github.com/skezo)! - Replace `tabs` permission with `activeTab` for minimal permission footprint

- Updated dependencies [[`94102c1`](https://github.com/brew-lab/thaumic-cast/commit/94102c1444f01b81c23e43ae4c56c731d71579c3), [`36b0c9f`](https://github.com/brew-lab/thaumic-cast/commit/36b0c9fe5af688a692756eb3f066b494d0ae8441), [`3a12f9a`](https://github.com/brew-lab/thaumic-cast/commit/3a12f9aea098aeda38ee956827bb837ce7304e07)]:
  - @thaumic-cast/ui@2.0.0
  - @thaumic-cast/protocol@0.3.0

## 0.10.4

### Patch Changes

- [#49](https://github.com/brew-lab/thaumic-cast/pull/49) [`f8824d1`](https://github.com/brew-lab/thaumic-cast/commit/f8824d1dbc5bdef26a6e693dda4b002d910bc133) Thanks [@skezo](https://github.com/skezo)! - Fix service ID check to match thaumic-core constant

## 0.10.3

## 0.10.2

### Patch Changes

- [#45](https://github.com/brew-lab/thaumic-cast/pull/45) [`5f08652`](https://github.com/brew-lab/thaumic-cast/commit/5f08652d8d7641ca7a51e2419e9d2867742a2a21) Thanks [@skezo](https://github.com/skezo)! - Fix desktop app download URL in onboarding to point to the correct GitHub releases page.

## 0.10.1

### Patch Changes

- [#43](https://github.com/brew-lab/thaumic-cast/pull/43) [`67708d1`](https://github.com/brew-lab/thaumic-cast/commit/67708d130418f63b69e64ca6ed2d6c5d37af09ba) Thanks [@skezo](https://github.com/skezo)! - Migrate extension settings from sync to local storage and add privacy policy
  - Switch from `chrome.storage.sync` to `chrome.storage.local` for all extension settings
  - Add one-time migration to preserve existing user settings
  - Add PRIVACY.md documenting data handling practices

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

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`a8ee07e`](https://github.com/brew-lab/thaumic-cast/commit/a8ee07e4510f88292c9452d8ead84ac79a3d077a) Thanks [@skezo](https://github.com/skezo)! - feat(extension): add bit depth selection to audio settings

  **Protocol:**
  - Add `supportedBitDepths` field to `CodecMetadata` interface for data-driven bit depth validation
  - Add `getSupportedBitDepths()` and `isValidBitDepthForCodec()` helper functions
  - Update schema refinement and `createEncoderConfig()` to use codec metadata instead of hardcoding FLAC checks

  **Extension Settings:**
  - Add `bitsPerSample` field to `CustomAudioSettings` schema with Zod validation
  - Fix `saveExtensionSettings` to deep merge `customAudioSettings` preserving all fields
  - Return Zod-validated settings from `saveExtensionSettings` to ensure React state has defaults applied
  - Fix settings hook to use returned validated settings instead of shallow merge

  **UI:**
  - Add bit depth dropdown in custom mode showing available options per codec (16-bit for most, 16/24-bit for FLAC)
  - Add bit depth row to "What You're Getting" display for all presets
  - Add streaming buffer row to "What You're Getting" display for PCM codec
  - Refactor resolved settings display to data-driven approach for maintainability

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`9ee78a4`](https://github.com/brew-lab/thaumic-cast/commit/9ee78a4240e0abe22ddff3765baf18988de2f9b3) Thanks [@skezo](https://github.com/skezo)! - Use codec-aware frame sizes for optimal encoder efficiency

  **Frame sizes by codec:**
  - AAC: 1024 samples (spec-mandated per ISO/IEC 14496-3)
  - FLAC: 4096 samples (~85ms at 48kHz, larger frames improve compression)
  - Vorbis: 2048 samples (~42.7ms at 48kHz, good VBR balance)
  - PCM: 10ms worth of samples (low latency)

  **Protocol changes:**
  - Added `frameDurationMs` field to `EncoderConfig` schema
  - Added `FRAME_DURATION_MS_MIN` (5ms), `FRAME_DURATION_MS_MAX` (150ms), `FRAME_DURATION_MS_DEFAULT` (10ms) constants
  - Frame duration now sent to server in handshake for proper cadence timing

  **Why 150ms max?**
  - AAC at 8kHz requires 128ms frames (1024 samples is spec-mandated)
  - FLAC benefits from 85ms frames at 48kHz for better compression

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`823bbf7`](https://github.com/brew-lab/thaumic-cast/commit/823bbf7ec9cf517ddf5e1076c195de7e05b8be2b) Thanks [@skezo](https://github.com/skezo)! - Add configurable frame duration setting for PCM streaming
  - Add `frameDurationMs` field to encoder config (10ms, 20ms, or 40ms)
  - Expose Frame Duration dropdown in extension Audio settings (PCM only)
  - Display frame duration in "What You're Getting" resolved settings
  - Default remains 10ms for low latency; larger values improve stability on slow networks
  - Field named generically for future extension to other codecs

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`9f57b44`](https://github.com/brew-lab/thaumic-cast/commit/9f57b44694cae0e10b6ff87ef544d462537fb3e2) Thanks [@skezo](https://github.com/skezo)! - Add extension-side ramp when underflow happens before sending PCM

  **Underflow Ramp-Down**
  - Detect underflow via `Atomics.waitAsync` timeout (200ms)
  - Capture last samples from partial frame buffer for continuity
  - Apply 3ms linear fade-out from last amplitude to silence
  - Fill remainder of frame with zeros before encoding

  **Resume Ramp-In**
  - Track `needsRampIn` flag when underflow occurs
  - Apply 3ms linear fade-in on first frame after resume
  - Only clear flag if ramp was actually applied (guards edge cases)

  **Implementation**
  - Shared `applyRamp()` utility for both fade-in and fade-out (DRY)
  - Reusable `lastSamples` buffer to avoid allocation on underflow
  - Frame-based ramp math ensures all channels get identical gain
  - Proper interpolation: fade-in starts at 0, fade-out starts at 1

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

- [#39](https://github.com/brew-lab/thaumic-cast/pull/39) [`b2d3b7c`](https://github.com/brew-lab/thaumic-cast/commit/b2d3b7c146d183217d79c04004f775c8dbedf0c8) Thanks [@skezo](https://github.com/skezo)! - Add frame queue for quality mode backpressure decoupling

  **Problem**

  In quality mode, WebSocket backpressure would pause the entire consume loop, blocking ring buffer draining. This caused the ring buffer to fill up, leading to producer drops and audible clicks when playback resumed.

  **Solution**

  Replace pause-based backpressure handling with a bounded frame queue that decouples WebSocket backpressure from ring buffer draining:
  - Queue up to 8MB (~30 seconds) of encoded frames during WebSocket backpressure
  - Continue draining ring buffer and encoding even when WebSocket is slow
  - Only block on encoder backpressure (unavoidable bottleneck)

  **Frame Queue Management**
  - Hysteresis at 67% prevents oscillation when trimming overflow
  - O(n) splice operations instead of O(n²) shift loops
  - Flush all queued frames on cleanup to avoid data loss
  - Track queue size, bytes, and overflow drops in stats

  **Producer Drop Detection**
  - Monitor `CTRL_DROPPED_SAMPLES` for worklet-side drops
  - Apply fade-in ramp on first frame after producer drops
  - Unified with existing underflow ramp logic (single `needsRampIn` flag)

  **Type Safety**
  - New `worker-messages.ts` with shared `WorkerInboundMessage` / `WorkerOutboundMessage` types
  - Proper typing for worker↔session communication

  **Protocol Changes**
  - Add `FRAME_QUEUE_HYSTERESIS_RATIO` constant (0.67)
  - Remove unused `wsBufferResumeThreshold` from `StreamingPolicy`

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`2109faf`](https://github.com/brew-lab/thaumic-cast/commit/2109faf6fa40452a56789ddd08f22ccf08d884bb) Thanks [@skezo](https://github.com/skezo)! - Add quality-first streaming policy for audio

  **StreamingPolicy Abstraction**

  Introduce `StreamingPolicy` that derives buffer sizing, drop thresholds, and backpressure behavior from `latencyMode`. This provides a single source of truth for all tunable constants in the audio streaming pipeline.

  **Quality Mode (music, podcasts)**
  - 10-second ring buffer for maximum jitter absorption
  - No catch-up mechanism - buffer can grow freely
  - Pause on backpressure instead of dropping frames
  - 500ms server streaming buffer for stability
  - Eliminates clicks/pops during music streaming to Sonos

  **Realtime Mode (video sync, low-latency)**
  - 3-second ring buffer for bounded memory
  - Catch-up when >1s behind, targeting 200ms
  - Drop frames on backpressure to maintain timing
  - 200ms server streaming buffer for lower latency

  Custom `streamingBufferMs` in settings still overrides policy defaults.

### Patch Changes

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`7629de4`](https://github.com/brew-lab/thaumic-cast/commit/7629de408fa0aad7e2a454726d890fb32df3d6ee) Thanks [@skezo](https://github.com/skezo)! - Add TPDF dithering to audio quantization

  Apply Triangular Probability Density Function (TPDF) dithering when quantizing Float32 samples to integer formats. This decorrelates quantization error from the signal, converting audible harmonic distortion into inaudible white noise floor.

  **Changes**
  - Add `tpdfDither()` utility function to protocol package
  - Apply dithering in PCM encoder (Float32 → Int16)
  - Apply dithering in FLAC encoder 24-bit path (Float32 → Int24)

  Improves audio quality especially in quiet passages, fade-outs, and music with wide dynamic range.

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`2eb1aae`](https://github.com/brew-lab/thaumic-cast/commit/2eb1aaec212dc248b6a93f35742881931a95832a) Thanks [@skezo](https://github.com/skezo)! - Optimize production performance by eliminating debug-only overhead
  - Add `__DEBUG_AUDIO__` build-time flag for audio diagnostics (enabled in dev, eliminated in prod)
  - Guard per-sample clipping detection with build flag, removing ~192k/sec overhead in production
  - Increase stats posting interval from 1s to 2s to reduce message-passing load on low-end devices

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

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`0057163`](https://github.com/brew-lab/thaumic-cast/commit/0057163d79b4cad8602098c75515532e1989e201) Thanks [@skezo](https://github.com/skezo)! - Pre-allocate PCM processor conversion buffer to eliminate real-time audio thread allocations
  - Move conversionBuffer allocation from process() to constructor
  - Size buffer for maximum case (128 samples × 2 channels = 256 floats)
  - Eliminates potential GC-induced audio glitches on low-end devices

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

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`87ce14a`](https://github.com/brew-lab/thaumic-cast/commit/87ce14a5d9de306b9b61f734da65070ae7122549) Thanks [@skezo](https://github.com/skezo)! - Improve audio pipeline timing with performance.now()-based rate control
  - Add time-based frame pacing to produce frames at ~20ms intervals instead of burst processing
  - Replace frame-count based draining with time-budget based approach (~4ms per wake cycle) to avoid setTimeout timer coalescing issues
  - Check backpressure per-frame instead of per-wake for finer-grained flow control
  - Allow burst catch-up of ~3 frames when recovering from brief stalls, with drift clamping to prevent unbounded catch-up

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`0b1764e`](https://github.com/brew-lab/thaumic-cast/commit/0b1764e7341741be4f92f407fe249f284395f1a0) Thanks [@skezo](https://github.com/skezo)! - Optimize PCM processor clamping loop with 4x unrolling
  - Unroll sample clamping loop by 4 for better instruction-level parallelism
  - Replace ternary chain with Math.max/min for JIT-friendly clamping
  - Use `s || 0` pattern for branchless NaN-to-zero conversion
  - Remove unused clippedSampleCount debug instrumentation

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`be4e2d0`](https://github.com/brew-lab/thaumic-cast/commit/be4e2d0c281f8f3ec0cb24cbe00bec55c97808d9) Thanks [@skezo](https://github.com/skezo)! - refactor: make Zod the single source of truth for message types

  **Extension Message Schemas (`message-schemas.ts`):**
  - Add ~50 Zod schemas for all extension message types
  - All types now derived via `z.infer<>` instead of manual interface definitions
  - Add schemas for: cast messages, metadata messages, connection messages, WebSocket messages, state updates, control commands, video sync messages

  **Extension Messages (`messages.ts`):**
  - Remove all manual interface definitions (reduced from 806 to 429 lines)
  - Re-export all types and schemas from `message-schemas.ts`
  - Keep only directional union types (`PopupToBackgroundMessage`, `BackgroundToOffscreenMessage`, etc.)

  **Protocol WebSocket (`websocket.ts`):**
  - Convert `WsControlCommand` from manual type union to `WsControlCommandSchema` using `z.discriminatedUnion()`
  - Add validation for volume (0-100 range) in SET_VOLUME command

  **Extension Settings (`settings.ts`):**
  - Convert `SpeakerSelectionState` from manual interface to `SpeakerSelectionStateSchema`
  - Update `loadSpeakerSelection()` to use `safeParse()` for runtime validation

- Updated dependencies [[`6921795`](https://github.com/brew-lab/thaumic-cast/commit/6921795b559217b5ee5342852e7c59b80fc858d4), [`7629de4`](https://github.com/brew-lab/thaumic-cast/commit/7629de408fa0aad7e2a454726d890fb32df3d6ee), [`a8ee07e`](https://github.com/brew-lab/thaumic-cast/commit/a8ee07e4510f88292c9452d8ead84ac79a3d077a), [`9ee78a4`](https://github.com/brew-lab/thaumic-cast/commit/9ee78a4240e0abe22ddff3765baf18988de2f9b3), [`823bbf7`](https://github.com/brew-lab/thaumic-cast/commit/823bbf7ec9cf517ddf5e1076c195de7e05b8be2b), [`4082c40`](https://github.com/brew-lab/thaumic-cast/commit/4082c40e2b7bef74d4a46d61c7325880a2169ddd), [`f158fb2`](https://github.com/brew-lab/thaumic-cast/commit/f158fb22a398e1adcac5b344b118a10a9bdcde61), [`b2d3b7c`](https://github.com/brew-lab/thaumic-cast/commit/b2d3b7c146d183217d79c04004f775c8dbedf0c8), [`08673ee`](https://github.com/brew-lab/thaumic-cast/commit/08673eee4b0c1916f7e4abb79caa49effcffc4f7), [`2109faf`](https://github.com/brew-lab/thaumic-cast/commit/2109faf6fa40452a56789ddd08f22ccf08d884bb), [`478ab65`](https://github.com/brew-lab/thaumic-cast/commit/478ab650978fe271f8857307b835a4e1b61c5262), [`be4e2d0`](https://github.com/brew-lab/thaumic-cast/commit/be4e2d0c281f8f3ec0cb24cbe00bec55c97808d9)]:
  - @thaumic-cast/protocol@0.2.0
  - @thaumic-cast/ui@1.0.0

## 0.9.0

### Patch Changes

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`03e3c7e`](https://github.com/brew-lab/thaumic-cast/commit/03e3c7e02bc27047448f8c43e9b505eee99bad51) Thanks [@skezo](https://github.com/skezo)! - Use adaptive backoff for backpressure handling in audio consumer worker
  - Reduces CPU spinning during sustained backpressure from ~1000 wakeups/sec to ~25 wakeups/sec
  - Exponential backoff: 5ms → 10ms → 20ms → 40ms (capped) while backpressured
  - Recovers quickly when pressure eases by resetting consecutive cycle counter

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`5943fa0`](https://github.com/brew-lab/thaumic-cast/commit/5943fa0c896b0b6fce4b3c1d25f4cfa435f17a00) Thanks [@skezo](https://github.com/skezo)! - Convert CSS module classes from camelCase to kebab-case
  - Updated all CSS module class selectors to use kebab-case naming convention
  - Updated corresponding TSX imports to use bracket notation for kebab-case properties
  - Enforced by new stylelint selector-class-pattern rule

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`caa3e5d`](https://github.com/brew-lab/thaumic-cast/commit/caa3e5d02416764e11b68b4bb949f3a7ab1598e6) Thanks [@skezo](https://github.com/skezo)! - Debounce dominant color cache persistence
  - Refactored to use DebouncedStorage utility for consistency with other caches
  - Cache writes are now debounced (500ms) instead of firing on every extraction
  - Reduces chrome.storage.session.set calls during rapid image changes

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`8375f3a`](https://github.com/brew-lab/thaumic-cast/commit/8375f3a50b11df70d428d52a451141257c0b3123) Thanks [@skezo](https://github.com/skezo)! - Add manual server configuration to onboarding and new Disclosure component
  - When auto-discovery fails during onboarding, users can now manually configure the server URL
  - Added collapsible Disclosure component to shared UI package
  - Extracted testServerConnection utility for connection testing
  - Fixed WizardStep content padding to prevent focus outline clipping

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`e6c382b`](https://github.com/brew-lab/thaumic-cast/commit/e6c382b3137fc98264e3bd809314550c2c25ec5c) Thanks [@skezo](https://github.com/skezo)! - Default custom audio settings to PCM codec instead of AAC-LC

  PCM is always available as raw audio passthrough with no WebCodecs dependency, ensuring the default settings always work regardless of browser/system codec support.

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`1d38aa1`](https://github.com/brew-lab/thaumic-cast/commit/1d38aa1265c51a22787e33bf13e5f9c592277c79) Thanks [@skezo](https://github.com/skezo)! - Rate-limit healthy stats logging to reduce log noise
  - Diagnostic logs now fire immediately when issues are detected (drops, underflows)
  - When healthy, logs are rate-limited to once every 30 seconds as a heartbeat
  - Reduces log churn from 1/sec to 1/30sec during normal operation

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`2f7b86e`](https://github.com/brew-lab/thaumic-cast/commit/2f7b86e4f2c461a836adec7e91e3d8ce56c590c8) Thanks [@skezo](https://github.com/skezo)! - Use single-pass max for artwork selection
  - Replaces sort-based selection with O(n) single-pass approach
  - Avoids array allocation from Array.from()
  - Parses each size only once instead of multiple times during sort

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`070afca`](https://github.com/brew-lab/thaumic-cast/commit/070afca65cc5c323aa0cc2e57117be1e846d04ed) Thanks [@skezo](https://github.com/skezo)! - fix(ui): WCAG 2.1 AA accessibility improvements

  **SpeakerMultiSelect**
  - Replace incorrect `role="listbox"` with semantic `<fieldset>` and native checkboxes
  - Use `<label>` wrapping for proper accessible names

  **VolumeControl**
  - Add `:focus-visible` styling for slider thumbs (webkit + moz)
  - Use logical properties consistently (`block-size` instead of `height`)

  **Disclosure**
  - Add `aria-controls` and `aria-describedby` (only when elements exist in DOM)
  - Add `aria-hidden` to decorative chevron icon

  **StatusChip**
  - Add Lucide icons to convey status without relying on color alone (WCAG 1.4.1)

  **Button/IconButton**
  - Fix disabled state contrast using `opacity` + `grayscale` filter to preserve variant identity

  **ToggleSwitch**
  - Make `aria-label` a required prop for WCAG 4.1.2 compliance

  **Wizard**
  - Use `aria-labelledby` to reference step title

  **Alert**
  - Add `aria-hidden="true"` to dismiss button icon

  **Card**
  - Add `titleLevel` prop for configurable heading hierarchy

  **SpeakerVolumeRow**
  - Add `role="group"` with `aria-label` for speaker context
  - Make label props required for proper i18n support

  **Extension**
  - Add interpolated i18n keys for speaker-specific accessible labels

- Updated dependencies [[`5943fa0`](https://github.com/brew-lab/thaumic-cast/commit/5943fa0c896b0b6fce4b3c1d25f4cfa435f17a00), [`8375f3a`](https://github.com/brew-lab/thaumic-cast/commit/8375f3a50b11df70d428d52a451141257c0b3123), [`0bb42f7`](https://github.com/brew-lab/thaumic-cast/commit/0bb42f7d38b93fbb523c87978ef8de066d357b12), [`070afca`](https://github.com/brew-lab/thaumic-cast/commit/070afca65cc5c323aa0cc2e57117be1e846d04ed)]:
  - @thaumic-cast/ui@0.1.0

## 0.8.4

## 0.8.3

### Patch Changes

- [#32](https://github.com/brew-lab/thaumic-cast/pull/32) [`f633dda`](https://github.com/brew-lab/thaumic-cast/commit/f633dda4f4146a81a908c14a6b79dfc44ca6f674) Thanks [@skezo](https://github.com/skezo)! - ### Bug Fixes
  - **SpeakerMultiSelect**: Allow deselecting all speakers. Previously the last selected speaker's checkbox was disabled to prevent empty selection. Now all checkboxes behave consistently, and the Cast button disables when no speakers are selected.
  - **Speaker Selection**: Fix auto-reselection bug where clearing all speakers would immediately re-select the first one. Auto-selection now only occurs on initial load.
  - **Speaker Ordering**: Sort speaker groups alphabetically by name for consistent UI ordering. Previously order could vary depending on which speaker responded to topology queries.
  - **Speaker Selection Persistence**: Remember selected speakers across popup opens. Selection is stored in chrome.storage.local (device-specific). On load, validates saved IPs against available speakers and falls back to auto-select if speakers are no longer available.

  ### Features
  - **Multi-Speaker Volume Controls**: When multiple speakers are selected, show labeled volume controls for each speaker instead of just the first one. Each control displays the speaker name and allows independent volume/mute adjustment before casting.

- [#30](https://github.com/brew-lab/thaumic-cast/pull/30) [`ed53246`](https://github.com/brew-lab/thaumic-cast/commit/ed5324601596c527a378fe56a95b4d33aab1b83f) Thanks [@skezo](https://github.com/skezo)! - ### Refactoring & Code Quality
  - **Route System**: Replace switch-based router with typed route registry and `registerValidatedRoute` factory, eliminating 17 manual `.parse()` calls
  - **Message Types**: Reorganize message types by direction (inbound/outbound), remove deprecated types and unused exports
  - **Domain Models**: Add `Speaker` and `SpeakerGroupCollection` domain models with type-safe operations
  - **Service Layer**: Add `OffscreenBroker` for type-safe offscreen communication, `NotificationService`, and `PersistenceManager`
  - **Hook Extraction**: Extract reusable hooks (`useChromeMessage`, `useMountedRef`, `useOptimisticOverlay`, `useStorageListener`, `useSpeakerSelection`, `useExtensionSettingsListener`) to reduce boilerplate
  - **Background Split**: Split monolithic `main.ts` files into focused domain handler modules
  - **Validation**: Add Zod schema validation for runtime message type safety

  ### Bug Fixes
  - Fix auto-stop notification timer lifecycle (prevent race conditions with rapid notifications)
  - Add FIFO eviction to in-memory dominant color cache (prevent unbounded growth)
  - Preserve reconnect counter across WebSocket reconnection attempts
  - Clean up sessions properly on disconnect
  - Preserve `supportedActions` and `playbackState` in metadata validation
  - Fix message type shape mismatches

  ### Performance
  - Only poll for video elements when video sync is enabled (eliminates unnecessary `getBoundingClientRect` calls)

  ### Cleanup
  - Remove dead code: `device-config.ts`, `getModeLabel`, `BitrateSelector`, `CodecSelector`, `createDebouncedStorage`, `clearDiscoveryCache`
  - Remove unused Battery Status API permission
  - Remove redundant `SESSION_HEALTH` message
  - Add `noop` utility for explicit silent error handling

- Updated dependencies [[`f633dda`](https://github.com/brew-lab/thaumic-cast/commit/f633dda4f4146a81a908c14a6b79dfc44ca6f674)]:
  - @thaumic-cast/ui@0.0.5

## 0.8.2

### Patch Changes

- [#28](https://github.com/brew-lab/thaumic-cast/pull/28) [`21e4991`](https://github.com/brew-lab/thaumic-cast/commit/21e4991c5769c6d50b7cff677d05245fb6021afa) Thanks [@skezo](https://github.com/skezo)! - Fix SoC and DRY violations across extension and UI packages

  **Extension:**
  - Fix connection state sync after service worker wake-up
  - Unify connection state to single source of truth
  - Centralize discovery/connection logic in background
  - Centralize stop-cast cleanup in stopCastForTab
  - Move i18n translations to presentation layer
  - Use validated settings module for init functions
  - Extract codec cache to shared module

  **UI:**
  - Remove hardcoded English defaults from ActionButton labels for i18n support

- Updated dependencies [[`21e4991`](https://github.com/brew-lab/thaumic-cast/commit/21e4991c5769c6d50b7cff677d05245fb6021afa)]:
  - @thaumic-cast/ui@0.0.4

## 0.8.1

### Patch Changes

- Updated dependencies [[`7af7ee1`](https://github.com/brew-lab/thaumic-cast/commit/7af7ee150acabc9812cf74bd8d1c9edd1e8edded)]:
  - @thaumic-cast/ui@0.0.3

## 0.8.0

### Minor Changes

- [#24](https://github.com/brew-lab/thaumic-cast/pull/24) [`2a2941e`](https://github.com/brew-lab/thaumic-cast/commit/2a2941e97ddd5861b5e13ad35eee09f5dd65a95f) Thanks [@skezo](https://github.com/skezo)! - Sync tab media playback with Sonos transport state - pauses tab when any speaker pauses, resumes when all speakers are playing

## 0.7.0

### Patch Changes

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`396fc4a`](https://github.com/brew-lab/thaumic-cast/commit/396fc4ac72ab8123bf8205db2fc0d68af9354472) Thanks [@skezo](https://github.com/skezo)! - Improve video sync with SE-based stability and event handling
  - Use standard error (SE) for stability gate instead of raw stdev - converges properly under RelTime quantization
  - Add p10 estimator with adaptive floor for lock latency selection
  - Add video event listeners for re-acquire on seeked, waiting, stalled, pause, play
  - Use persisted stall check (400ms) to avoid transient re-acquires from adaptive streaming hiccups
  - Add sync jump detection logging for debugging
  - Use requestVideoFrameCallback (RVFC) for frame-accurate sync when available
  - Add playbackRate fighting detection with automatic pause mode fallback
  - Record coarse alignment anchors at pause start (not after wait) to fix double-delay bug

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`afbe950`](https://github.com/brew-lab/thaumic-cast/commit/afbe95005caa9dea84483d1fea0fe0c93e65e714) Thanks [@skezo](https://github.com/skezo)! - Add video sync opt-in feature with per-cast toggle
  - Add global video sync setting in Options (under Advanced section)
  - Add per-cast video sync toggle in ActiveCastCard popup UI
  - Add StatusChip and ToggleSwitch UI components with WCAG AA compliant colors
  - Status chip backgrounds use dominant artwork color for visual cohesion
  - Fix re-acquire loop caused by coarse alignment triggering play event
  - Disable video sync automatically when cast stops
  - Prevent log spam when video sync enabled on page without video element

- Updated dependencies [[`afbe950`](https://github.com/brew-lab/thaumic-cast/commit/afbe95005caa9dea84483d1fea0fe0c93e65e714)]:
  - @thaumic-cast/ui@0.0.2
  - @thaumic-cast/protocol@0.1.1

## 0.6.1

## 0.6.0

### Minor Changes

- [#17](https://github.com/brew-lab/thaumic-cast/pull/17) [`cf0b867`](https://github.com/brew-lab/thaumic-cast/commit/cf0b867942b54fd1f099d1bc031ebe1cc5f2b860) Thanks [@skezo](https://github.com/skezo)! - Add server-side WAV encoding for lossless audio streaming
  - Add "Lossless (WAV)" codec option that sends raw PCM from browser to desktop app
  - Desktop app wraps PCM in WAV container for true lossless quality
  - Works universally since PCM passthrough has no browser codec dependencies
  - Hide bitrate selector in UI for lossless codecs (no bitrate options)

### Patch Changes

- [#17](https://github.com/brew-lab/thaumic-cast/pull/17) [`18e2e0e`](https://github.com/brew-lab/thaumic-cast/commit/18e2e0e0431c0022f9d382f49ed1228897ea3b41) Thanks [@skezo](https://github.com/skezo)! - Improve audio settings and codec detection
  - Remove legacy AudioSettings code (dead code cleanup)
  - Fix codec detection to run via offscreen document (AudioEncoder not available in service workers)
  - Add latencyMode option to custom audio settings (quality/realtime)
  - Hide latencyMode UI for codecs that don't use WebCodecs (PCM)
  - Default to high quality (lossless) audio mode for lower CPU usage

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

### Patch Changes

- [#13](https://github.com/brew-lab/thaumic-cast/pull/13) [`4d7d238`](https://github.com/brew-lab/thaumic-cast/commit/4d7d238e381441988da6254205a23283746ad353) Thanks [@skezo](https://github.com/skezo)! - Refactor popup UI to integrate controls into media cards
  - Move speaker selection, volume controls, and cast button into CurrentTabCard
  - Add volume controls and stop button to ActiveCastCard
  - Remove separate "Cast settings" card for cleaner UI
  - Reorder layout: Active Casts now appear above Current Tab

## 0.4.0

### Minor Changes

- [#11](https://github.com/brew-lab/thaumic-cast/pull/11) [`5b6d1f2`](https://github.com/brew-lab/thaumic-cast/commit/5b6d1f2022a200c08357f7eb40c294d5aa58a9e6) Thanks [@skezo](https://github.com/skezo)! - Add settings page with audio presets and server configuration
  - Add options page with server, audio, language, and about sections
  - Create preset resolution system that integrates runtime codec detection
  - Support auto/low/mid/high/custom audio modes with fallback chains
  - Add server auto-discover with manual URL override option
  - Move audio configuration from popup to dedicated settings page
  - Use shared UI components (Card, Button) from @thaumic-cast/ui
  - Replace console.\* with shared logger throughout extension

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

## 0.2.0

### Minor Changes

- [#5](https://github.com/brew-lab/thaumic-cast/pull/5) [`1f32958`](https://github.com/brew-lab/thaumic-cast/commit/1f32958fb07f8580f36ce118d98fd9597d0244c6) Thanks [@skezo](https://github.com/skezo)! - Reduced audio encoder memory allocations — Audio encoders (AAC, Vorbis, FLAC) now use pre-allocated buffers for format conversion, reducing per-frame allocations from 2-4 down to 1. This prevents GC-induced stuttering and crackling on low-end devices.

- [#5](https://github.com/brew-lab/thaumic-cast/pull/5) [`1f32958`](https://github.com/brew-lab/thaumic-cast/commit/1f32958fb07f8580f36ce118d98fd9597d0244c6) Thanks [@skezo](https://github.com/skezo)! - Increase ring buffer from 1 second to 2 seconds, providing more headroom during CPU spikes and switch WebCodecs `latencyMode` from `realtime` to `quality` for better audio at same bitrate

## 0.1.1

### Patch Changes

- [#2](https://github.com/brew-lab/thaumic-cast/pull/2) [`e9169f5`](https://github.com/brew-lab/thaumic-cast/commit/e9169f5094b25262f7f376b82954d46160ca9f40) Thanks [@skezo](https://github.com/skezo)! - Fix runtime errors and audio streaming issues
  - Fix nested anchor tags in Sidebar causing "improper nesting of interactive content" warnings
  - Fix TypeScript types to match Rust backend ZoneGroup structure
  - Fix undefined coordinator access causing infinite re-render loop
  - Fix AudioWorkletNode not connected to audio graph, preventing audio capture
  - Fix codec mismatch in WebSocket handshake causing wrong Content-Type for Sonos
  - Fix XML escaping in SOAP/DIDL to escape all 5 XML special characters (was missing " and ')
