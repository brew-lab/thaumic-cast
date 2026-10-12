# Real-extension check

The screenshot harness and the design-system catalogue draw the popup with stubs. This rig
runs what ships: the built extension, unpacked in real Chromium, with its real toolbar popup
(`chrome.action.openPopup()`, at its natural size) and real tab capture, against the real
companion router. Only the speakers are fake: `real_ext_companion` in thaumic-core serves the
crate's fake household (six rooms, Bathroom and Office grouped) and sends the events real
speakers would. Run it for any popup or options change before asking for a review.

## Needs

- Linux with `xvfb-run` (the popup only opens in a headed browser).
- Playwright's Chromium: `bunx playwright install chromium` (branded Chrome no longer loads
  an unpacked extension from the command line). `CHROME=/path/to/chrome` picks another build.
- Nothing listening on 49400 (the companion), 49499 (its control API) or 8765 (the tone page).

## The scripted pass

```sh
apps/extension/real-ext/run.sh
```

It builds the extension and the thaumic-core test binary, then for each run (`RUNS`, by default
`1:light 1.25:dark`, a device scale and a scheme) starts a fresh companion and walks the popup:
onboarding on every step and state (the companion found, not found, given by hand: one block
size, and the main popup's header row, card edges, text edge and bar), the main popup's layout, a
room row's octagon on press and focus, the CastBar's line above Cast in every state, saving a set,
casting (the band bleeding to the card, no Go
to tab on the cast's own tab), adding a grouped room whose first event is lost, a second tab, a
speaker dropping off the network and the Undo Toast, rooms joining slowly beside a room playing
alone (every row's Slider on one start and end), a cast in every room (no Add a room), and
Settings › Saved sets (rename, Escape, remove, Undo, a long name in Settings and in the popup).
Then the rooms
pass (`rooms.mjs`), with every new subscription's first event lost: rooms leave a cast, come back
with Undo and are added again, a second tab takes a room of the first cast, a grouped room is
cast alone, and the lead of a group playing music is cast alone, leaving the music to a room with
nothing on record; every cast room must show its level within about a second, a cast that loses a room
must play on in the rest, Stop must put every room back, and "In use" must match what the
household plays. Each step is
checked and screenshotted into `real-ext/shots/` (`REALEXT_SHOTS` moves them). It prints PASS or
FAIL per check and exits 1 on any failure.

- `SKIP_BUILD=1` reuses `dist/` (the companion binary is always rebuilt, which is quick when
  nothing changed).
- `CARGO_TARGET_DIR` is honoured, for a worktree with its own target directory.

When a review finds something the pass missed, add a check for it to `check.mjs`.

## Exploring by hand

Start the companion, then a long-lived browser, and post snippets to it:

```sh
cargo test -p thaumic-core --lib real_ext_companion -- --ignored --nocapture &
xvfb-run -a node apps/extension/real-ext/drive.mjs &
apps/extension/real-ext/d.sh 'S.tab = await env.audioTab(); S.p = await env.popup(); return S.p.text()'
apps/extension/real-ext/d.sh 'await S.p.clickRoom("Kitchen"); return S.p.shot("kitchen")'
```

A snippet is the body of an async function of `env` (what `lib.launch()` returns: `popup()`,
`options()`, `audioTab()`, `attach()`, the service worker `sw`), `S` (state kept between
snippets) and `lib` (`control()`, `sleep()`, `METRICS`). `FRESH=0` keeps the profile, `SCALE`
sets the device scale and `DPORT` the driver's port.

The household is changed through the companion's control API, for example:

```sh
curl -X POST '127.0.0.1:49499/volume?room=Office&v=20'
curl -X POST '127.0.0.1:49499/regroup?member=Study&coordinator=Kitchen'
curl -X POST '127.0.0.1:49499/vanish?room=Office'        # drops off the network
curl -X POST '127.0.0.1:49499/slow?room=Kitchen&action=SetAVTransportURI&ms=6000'  # 0 undoes it
curl -X POST '127.0.0.1:49499/knobs?initial_rc=0'         # lose each room's first level event
curl -X POST '127.0.0.1:49499/knobs?initial_grc=0&initial_avt=0'  # and its group's, and its transport's
curl 127.0.0.1:49499/state
```

`REALEXT_ROOMS`, `REALEXT_GROUPS` (`Coordinator+Member;...`), `REALEXT_VERSION` and
`REALEXT_APPTYPE=desktop` shape the household and the companion it claims to be.
`REALEXT_LOG=debug` prints the companion's log on stderr.

## What it does not cover

The Windows renderer (font hinting, its scrollbar art), touch, and the desktop app's scrollers.
