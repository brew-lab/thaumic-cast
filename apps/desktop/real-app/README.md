# Real-app check

The catalogue draws the desktop's parts with stubs. This rig runs what ships: the desktop
frontend's production build (`vite build`, as Tauri bundles it), under the Tauri app's
Content-Security-Policy, in Playwright's **WebKit** (the desktop's engine on macOS and Linux)
and **Chromium** (WebView2 on Windows), with every Tauri command answered by the **real core**.
Only the speakers are fake: `real_desktop_companion` in thaumic-core serves the crate's fake
household (six rooms, Bathroom and Office grouped, the pump that sends the events real speakers
would) and the desktop's commands over HTTP. Run it for any desktop change before asking for a
review.

## How it fits together

- `tauri-shim.js` is added to the page before the app's scripts. It stands in for
  `window.__TAURI_INTERNALS__`: each command goes to `POST /ipc/{command}`, `listen()` to the
  `GET /ipc/events` stream (the events mapped by core's `frontend_event`, as the Tauri emitter
  maps them), the app version comes from `package.json`, `shell.open` is recorded in
  `window.__REALAPP_OPENED__`, and any other plugin call throws.
- `lib.mjs` serves `dist/` (with a history fallback for `/server`, `/settings` and any other
  route) under `tauri.conf.json`'s policy, with the inline script's hash added as Tauri adds it,
  and passes `/ipc/*` through to the companion so the page stays same-origin.
- `real_desktop.rs` (thaumic-core, test-only) answers each command in the app's
  `generate_handler!` by calling the services the Tauri command calls. What only the operating
  system or the Tauri app can do is a marked stub: launch at login and the manual speaker list
  are kept in memory, the platform is `REALAPP_PLATFORM` (`linux` by default), showing the
  window and restarting do nothing, and the speaker settings are kept in the companion's config
  rather than the settings file. `run.sh` fails when a command has no arm.

## Needs

- Playwright's WebKit and Chromium: `bunx playwright install webkit chromium`.
- Nothing listening on 49410 (the companion), 49509 (its control API) or 49520 (the page);
  `REALEXT_PORT`, `REALEXT_CONTROL_PORT` and `REALAPP_PORT` move them. They differ from the
  real-extension rig's, so both can run at once.

## The scripted pass

```sh
apps/desktop/real-app/run.sh
```

It builds the frontend and the thaumic-core test binary, then for each run (`RUNS`, by default
`chromium:1:light chromium:1.25:dark webkit:1:light webkit:1.25:dark`: an engine, a device
scale and a scheme) starts a fresh companion and walks the app at the default window (840 ×
640), a narrow one (600 × 640, under 45rem) and a wide one (1280 × 800):

- onboarding, every step, from a fresh profile: Skip, Back and Carry on on one line, Back from
  step 2, the rule above the footer, Carry on in view without scrolling (the footer is pinned)
  and a tabbed-to control never under it, the full form not a modal, the rooms counted;
- Rooms with nothing cast and with a real cast (`POST /cast`): one card per room, a grouped
  room's "Grouped with", casting rooms first, each name at least 6ch and never under its Badge,
  each sub line one line and whole, Stop all casts only while something casts, Copy URL (Chromium
  copies; WebKit's clipboard refuses and the URL is revealed);
- Stop all casts: the Dialog starts on Cancel, Esc cancels and gives focus back, Stop ends every
  cast on the core, focus lands on a control, the toast row says what stopped, outside the
  scroller and clear of focus, and goes on the next action; a room the Sonos app groups under a
  casting room (`/regroup`) says Casting, not In use;
- Server: Restart, Disconnect and Stop one width, Stop disabled while idle, the Disconnect and
  Stop Dialogs, focus on a control after Stop;
- Settings: every section's controls on one edge, the rules between items, About's readout
  (its value regular, on the card's end edge, beside its term), Show diagnostics
  disabled without speaker monitoring, and the reserve Meter on a casting card after an injected
  reading (`POST /health`; the fake speakers have no playout clock, so the monitor never measures
  one here), and Reset all settings: with settings changed it asks first in the Dialog, Cancel
  changes nothing and gives focus back, Reset puts every setting back to its default (read back
  through the commands) and keeps the port and the speakers added by IP address;
- About's Show again: the onboarding at once, over the window, at step 1; Skip goes back to the
  window on Rooms with the onboarding marked skipped, and no setting changed;
- Not found: its title the page heading, Back to Rooms a link that goes there;
- at every view: exactly one scroller, nothing wider than the window, the rail narrow under 45rem
  and wide from it, axe in this run's scheme, and no console errors, failed requests or
  exceptions.

Each step is screenshotted into `real-app/shots/` (`REALAPP_SHOTS` moves them). It prints PASS or
FAIL per check and exits 1 on any failure. A check named in `expected-fail.json` prints XFAIL when
it fails and fails the run when it passes (XPASS), so the list can only shrink: it held what
today's app got wrong when the rig was written, and the rebuild empties it.

- `SKIP_BUILD=1` reuses `dist/` (the companion binary is always rebuilt, which is quick when
  nothing changed).
- `CARGO_TARGET_DIR` is honoured, for a worktree with its own target directory.

When a review finds something the pass missed, add a check for it to `check.mjs`.

## By hand

```sh
REALEXT_PORT=49410 REALEXT_CONTROL_PORT=49509 \
  cargo test -p thaumic-core --lib real_desktop_companion -- --ignored --nocapture &
curl -X POST '127.0.0.1:49509/cast?rooms=Kitchen,Office&codec=pcm'
curl -X POST '127.0.0.1:49509/health?room=Kitchen&reserve=380&floor=150&target=1000'
curl -X POST 127.0.0.1:49509/ipc/get_playback_sessions -d '{}'
```

The real-extension companion's control API (`/volume`, `/regroup`, `/vanish`, ...) works on the
same port; see `apps/extension/real-ext/README.md`.

## What it does not cover

The desktop's floor engines: Playwright's WebKit is newer than WebKitGTK 2.44 and Safari 16.4,
and its Chromium is not WebView2, so their rendering (and the fallbacks the floors need) is
covered by the catalogue's floor mode (`?floor=1`), not here. Nor the native window (its size,
the title bar, the tray menu), the Rust side of each command beyond the core services it calls,
font hinting on Windows, or touch.
