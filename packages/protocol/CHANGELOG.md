# @thaumic-cast/protocol

## 0.6.0

### Minor Changes

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

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`602c9ee`](https://github.com/brew-lab/thaumic-cast/commit/602c9ee2ff71b41f4added085bda4a48c1d1154c) Thanks [@skezo](https://github.com/skezo)! - feat(protocol): say when another client takes a speaker, and show speakers in use

  Taking a speaker from another client sent a stop with no reason, so the other person saw a generic message. A distinct
  reason is now sent and shown. The extension also never read the session list the server provides, so availability came
  only from that browser's own casts and the automatic choice was always the first group alphabetically, meaning several
  machines defaulted to the same speaker and each showed it as free. Speakers in use by another client are now a
  separate state, skipped when choosing automatically and still selectable deliberately, and the concurrent stream count
  comes from the server rather than one browser's view.

### Patch Changes

- [#193](https://github.com/brew-lab/thaumic-cast/pull/193) [`644a955`](https://github.com/brew-lab/thaumic-cast/commit/644a955100483f155176286cf74fa0bb2627a400) Thanks [@skezo](https://github.com/skezo)! - fix(core): stop reporting a compressed cast's speaker as still locking

  A speaker's buffer can only be measured on a PCM stream. For AAC and FLAC the companion nevertheless reported the speaker
  as "locking" (still measuring) for the whole cast, as if a reading were on its way. It now reports "unmeasured" for those
  streams, in its log and to the extension and desktop app, and still says when such a speaker is paused, not answering or
  playing something else. PCM casts are reported exactly as before.

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

## 0.5.0

### Minor Changes

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

- [#97](https://github.com/brew-lab/thaumic-cast/pull/97) [`963170d`](https://github.com/brew-lab/thaumic-cast/commit/963170df0109686df84f47e998b63a1ffb7de6d8) Thanks [@skezo](https://github.com/skezo)! - Bump dev and production dependencies to current major versions: typescript 6, vite 8, i18next 26, react-i18next 17, lucide-preact 1, @changesets/changelog-github 0.6. Adds an `ImportMeta.env` ambient declaration in `@thaumic-cast/shared` so `logger.ts` continues to typecheck under TypeScript 6, and adds `typescript` as a direct devDependency of `@thaumic-cast/extension` so `tsc` resolves locally now that typescript-eslint pins TS 5 and prevents root hoisting.

- [#107](https://github.com/brew-lab/thaumic-cast/pull/107) [`b73b49e`](https://github.com/brew-lab/thaumic-cast/commit/b73b49ea5b15d115cb016f395074891c7f77cc95) Thanks [@skezo](https://github.com/skezo)! - Polish the companion version-mismatch surface introduced in the previous release, and unblock the path that was supposed to surface it for older companions.
  - Accept `INITIAL_STATE` payloads that omit `groupVolumeFixed`. That field was added after the initial protocol shipped; older companions don't send it, so the extension's `WS_CONNECTED` route rejected their messages at schema validation — `handleWsConnected` never ran, the popup stayed stuck at "Checking…", and the out-of-date warning (the very UI meant for this scenario) never had a chance to render. The `groupVolumeFixed` field now defaults to an empty map when missing, so older-companion payloads validate and the version-mismatch flow fires as designed.
  - Prevent the out-of-date warning Alert from briefly flashing on every initial connection. The popup was flipping `phase` to `'connected'` optimistically on `WS_STATE_CHANGED` before the async fetch that carries the companion metadata resolved, so `protocolVersion` was transiently `null` and the mismatch helper would light up the Alert for a single render. The connection-status hook now only transitions to `'connected'` via the metadata-bearing `CACHED_STATE_RECEIVED`, applying phase and metadata atomically. The companion-version hook additionally gates on `phase === 'connected'` so no flash window can open between discovery and WebSocket `INITIAL_STATE`.
  - Gate the Alert on the persisted dismissal record having loaded, closing a smaller race where a previously-dismissed warning briefly reappeared on popup open before `chrome.storage.local` resolved.
  - Rename the protocol line in the extension About card and the desktop Settings About card from `Protocol v{{version}}` to `Protocol · Version {{version}}`, matching the adjacent `Desktop App · Version {{version}}` / `Version {{version}}` format.

- [#105](https://github.com/brew-lab/thaumic-cast/pull/105) [`32ae247`](https://github.com/brew-lab/thaumic-cast/commit/32ae2471d81ace318b32080badceb578b8019ae5) Thanks [@skezo](https://github.com/skezo)! - Rename `streamingBufferMs` setting to `jitterBufferMs` across the stack

  Pure rename — no behavior change. Every value, default, clamp range, and UI option stays the same. Identifier updated on the protocol, core, extension, and desktop surfaces, plus docstrings and the one user-facing label ("Streaming Buffer" → "Jitter Buffer"). The setting has always functioned as a jitter buffer (holding PCM frames to smooth WebSocket-to-Sonos delivery variance), so the name now matches the role.

  Sets up a follow-up change that turns this from a passive sizing hint into an active fill-gate / refill-on-underrun state machine.

## 0.3.0

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

## 0.2.0

### Minor Changes

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

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`7629de4`](https://github.com/brew-lab/thaumic-cast/commit/7629de408fa0aad7e2a454726d890fb32df3d6ee) Thanks [@skezo](https://github.com/skezo)! - Add TPDF dithering to audio quantization

  Apply Triangular Probability Density Function (TPDF) dithering when quantizing Float32 samples to integer formats. This decorrelates quantization error from the signal, converting audible harmonic distortion into inaudible white noise floor.

  **Changes**
  - Add `tpdfDither()` utility function to protocol package
  - Apply dithering in PCM encoder (Float32 → Int16)
  - Apply dithering in FLAC encoder 24-bit path (Float32 → Int24)

  Improves audio quality especially in quiet passages, fade-outs, and music with wide dynamic range.

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`823bbf7`](https://github.com/brew-lab/thaumic-cast/commit/823bbf7ec9cf517ddf5e1076c195de7e05b8be2b) Thanks [@skezo](https://github.com/skezo)! - Add configurable frame duration setting for PCM streaming
  - Add `frameDurationMs` field to encoder config (10ms, 20ms, or 40ms)
  - Expose Frame Duration dropdown in extension Audio settings (PCM only)
  - Display frame duration in "What You're Getting" resolved settings
  - Default remains 10ms for low latency; larger values improve stability on slow networks
  - Field named generically for future extension to other codecs

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

- [#38](https://github.com/brew-lab/thaumic-cast/pull/38) [`08673ee`](https://github.com/brew-lab/thaumic-cast/commit/08673eee4b0c1916f7e4abb79caa49effcffc4f7) Thanks [@skezo](https://github.com/skezo)! - Reorganize protocol package into logical modules

  Split `index.ts` (1,570 lines) into 9 focused modules for better maintainability:
  - `audio.ts` - Codecs, bitrates, sample rates, bit depths, constants
  - `encoder.ts` - EncoderConfig, codec metadata, validation helpers
  - `codec-support.ts` - Runtime detection, presets, scoring
  - `stream.ts` - StreamConfig, CastStatus, ActiveCast, PlaybackResult
  - `websocket.ts` - All WsMessage types and schemas
  - `sonos.ts` - ZoneGroup, TransportState, SonosStateSnapshot
  - `events.ts` - SonosEvent, StreamEvent, LatencyEvent, BroadcastEvent
  - `media.ts` - MediaMetadata, TabMediaState, display helpers
  - `video-sync.ts` - VideoSyncState, LatencySample, constants

  100% backwards compatible - all existing imports continue to work via barrel re-exports.

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

## 0.1.1

### Patch Changes

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`afbe950`](https://github.com/brew-lab/thaumic-cast/commit/afbe95005caa9dea84483d1fea0fe0c93e65e714) Thanks [@skezo](https://github.com/skezo)! - Add video sync opt-in feature with per-cast toggle
  - Add global video sync setting in Options (under Advanced section)
  - Add per-cast video sync toggle in ActiveCastCard popup UI
  - Add StatusChip and ToggleSwitch UI components with WCAG AA compliant colors
  - Status chip backgrounds use dominant artwork color for visual cohesion
  - Fix re-acquire loop caused by coarse alignment triggering play event
  - Disable video sync automatically when cast stops
  - Prevent log spam when video sync enabled on page without video element

## 0.1.0

### Minor Changes

- [#17](https://github.com/brew-lab/thaumic-cast/pull/17) [`06ffe4f`](https://github.com/brew-lab/thaumic-cast/commit/06ffe4f80c6837314941d1e47115143f3bd44d2d) Thanks [@skezo](https://github.com/skezo)! - Add latency monitoring service for measuring audio playback delay
  - Add GetPositionInfo SOAP call to query Sonos playback position
  - Track stream timing via sample count for precise source position
  - Create LatencyMonitor service with high-frequency polling (100ms)
  - Calculate latency with RTT compensation and EMA smoothing
  - Emit LatencyEvent broadcasts with confidence scoring
  - Foundation for future video-to-audio sync feature
