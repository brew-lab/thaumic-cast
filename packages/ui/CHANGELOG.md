# @thaumic-cast/ui

## 4.0.0

### Minor Changes

- [#235](https://github.com/brew-lab/thaumic-cast/pull/235) [`aa16e97`](https://github.com/brew-lab/thaumic-cast/commit/aa16e9734156a630366037fd69dcb5f5ebc857dd) Thanks [@skezo](https://github.com/skezo)! - feat(ui): build the extension and the desktop app from the design system's atoms

  The design system's 23 basic parts (buttons, icon buttons, text fields, switches, checkboxes, radio buttons, the
  theme picker, dropdowns, sliders, status badges and dots, the busy indicator, artwork, tooltips, chips, headings,
  navigation items, the brand mark, the step dots and the reserve meter) are built, each drawn in every state in light
  and dark on the catalogue page and checked for accessibility. The extension's popup and settings page and the
  desktop app now use them, so both apps take the new look: the purple palette, Geist headings, the bevelled shape on
  hover and focus, a clearer focus ring, and Stop shown as a square with the word "Stop" rather than a cross. The
  theme in Settings is now a three-way switch (Auto, Light, Dark), the on/off settings are switches, and the desktop's
  sidebar narrows below a smaller window width. Results such as "Copied" are read out by screen readers once, from one
  place per screen. Nothing changes in how casting works.

- [#234](https://github.com/brew-lab/thaumic-cast/pull/234) [`07d890b`](https://github.com/brew-lab/thaumic-cast/commit/07d890b7001e8f773f76865573c6c2a018af0b23) Thanks [@skezo](https://github.com/skezo)! - feat(ui): lay the design system's foundations

  The shared UI package now carries the foundations of the design system, written up in `packages/ui/DESIGN.md`. The
  design tokens (colours, type, space, shape, motion and sizes, in light and dark) are generated from one table, so they
  match the drawings exactly and cannot drift; a test fails if the generated files go stale. The desktop gets a copy of
  the colour tokens for the older WebKit on macOS 13. Geist, the heading face, is bundled as one self-hosted file with
  its licence, so no build fetches a font from the web. Three small building blocks arrive: a row layout, an icon that
  draws only the 33 glyphs the design uses, and one announcer per screen that tells screen readers about results without
  repeating itself or speaking when the screen opens. A catalogue page shows all of it in light and dark and is checked
  for accessibility in CI, and `bun run lint:ds` reports where the apps still differ from the design system. Nothing in
  the extension or the desktop app looks different yet.

- [#237](https://github.com/brew-lab/thaumic-cast/pull/237) [`be8288c`](https://github.com/brew-lab/thaumic-cast/commit/be8288c8a819b6169e8451dd157aa2c959d1ab9e) Thanks [@skezo](https://github.com/skezo)! - feat(ui): build the settings pages and the notices from the design system's molecules

  The design system's shared molecules are built and drawn on the catalogue page in every state, in light and
  dark: fields, settings rows, choice groups, copy and address fields, readouts, folds, empty states, notices,
  toasts, page titles, wizard steps and cards. The extension's settings page and the desktop app's Speakers,
  Server and Settings views now use them: settings sit in rows with their help beside or under them, choices
  flow into columns, and every page has one large title. The server address and speaker address tests are one
  control that only shows busy on its button, says "Try again" when nothing answers, and now says straight away
  when a server address cannot be right. Copy buttons say "Copied" for a moment after a copy, and
  the Server page's copy button has a name at last. Every warning keeps its place but is read out by screen
  readers once, from one place per screen, instead of interrupting. Nothing changes in how casting works.

  Controls are now compact by default: buttons, fields and dropdowns are 32 px tall everywhere, and only the action a
  screen exists for (Stop all casts and Ask again, the setup steps, Cast) stays large. On the desktop app and under touch
  every control still answers a press across 44 px, so nothing got harder to hit on a touchscreen. Addresses you copy
  are shown as plain text with a small Copy button beside them, the theme switch is the same height as everything
  else, and the popup's Mute and Remove buttons are a little larger.

- [#242](https://github.com/brew-lab/thaumic-cast/pull/242) [`8b5579f`](https://github.com/brew-lab/thaumic-cast/commit/8b5579f77bde5164366a21eb6ee31eecee0b00f5) Thanks [@skezo](https://github.com/skezo)! - feat(desktop): rebuild the window and confirm Stop all casts

  The Speakers page shows one card per room, with the rooms that are casting first. A grouped room
  says which rooms it is grouped with, and says Casting, not "In use", when the Sonos app groups it
  with a room that is casting. A speaker's name is never squeezed beside its status. "Stop all casts"
  only shows while something is casting, and now asks first. Afterwards a message says how many casts
  stopped, and how many of them were started on another computer. On the Server page the three action
  buttons are one width, Stop is greyed out while nothing casts, and "Disconnect" asks first too. In
  the tray, "Stop all casts" is greyed out while nothing casts.

  Settings gains "Show diagnostics", which puts each casting speaker's reserve on its card (it needs
  speaker monitoring). Setup counts rooms rather than speakers, and lists each room with its group.
  Its Carry on button stays in view on a step taller than the window. A page that does not exist now
  says so with a way back to Speakers. The window opens a little taller.

- [#242](https://github.com/brew-lab/thaumic-cast/pull/242) [`8b5579f`](https://github.com/brew-lab/thaumic-cast/commit/8b5579f77bde5164366a21eb6ee31eecee0b00f5) Thanks [@skezo](https://github.com/skezo)! - feat(extension): tidy the settings page

  Every setting on the settings page now lines up: in each section the switches and lists end on one
  edge, including Theme, and a thin line divides one setting from the next. The four Quality choices
  read two by two, from Economical to Luxurious, "Finer points" comes before "Saved sets", and "Start
  no louder than" comes first in it. Saved sets says where sets are kept and how to make one.

  When the settings cannot be saved or loaded, the page now says so at the top instead of failing
  silently. While the settings load, the page says so with the moving dots. The "removed" message with
  Undo keeps clear of whatever has focus.

- [#239](https://github.com/brew-lab/thaumic-cast/pull/239) [`2c6fcaf`](https://github.com/brew-lab/thaumic-cast/commit/2c6fcaf8b317333dbcc09261be9f2fd077b8a6ce) Thanks [@skezo](https://github.com/skezo)! - feat(ui): build the popup's components from the design system

  The design system's popup parts are built and drawn on the catalogue page in every state, in light and dark: the
  room rows (choosing a room, a room in a running cast, and a read-only list), and the start level, which shows the
  level a room will start at, "…" while it is not known and "Fixed" for a fixed output, and opens a slider to set it
  by hand for this cast only. Nothing is sent to a speaker before Cast. The extension's popup moves onto them in a
  later change, so nothing changes on screen yet.

  The media head shows what a tab or the whole browser is playing, with the live dot while sound goes out. On an open
  cast it sits on a band tinted from the artwork, worked out per theme from the artwork's hue, with a purple-grey band
  for grey artwork; on a red band, Stop moves off it.

  A cast's volume is one line for one room, and from two rooms a master that shows the rooms' average, then a fold
  listing each room's level, with the rooms and "Add a room" inside it. The last room has no Remove button, since Stop
  ends the cast. "Sync video" is one switch with its state beside the name, and the fine-tune slider sits in a fold.

  The popup's header shows the mark, lit while casting, and who it is talking to, and never a count; a change of status
  is read out once. The cast button counts rooms ("Cast to 3 rooms"), keeps one line under it for what else will
  happen, shows a failure as a line above it, and has an add mode with Cancel and "Add 2 rooms". Everything wrong with a
  cast sits at that cast: the first problem in full, the rest as one line each, and one line on a folded cast.

  The room picker lists sets first (Last cast, saved sets, and Everywhere from three rooms), then the rooms. From eight
  rooms they fold: shut, it shows only the chosen rooms; open, a search filters them without ever unticking one, and
  says how many chosen rooms it hides. Chosen rooms can be saved as a set on this device. While nothing is connected
  the picker is disabled and says why.

  This tab's card shows what it plays over the room picker. A running cast is a tile that folds: compact, it shows
  what plays, Stop, one volume line and one problem line; open, the artwork band with the playback controls and "Go to
  tab", then the volume, the problems, notes and "Sync video". A single cast is always open. Stop never says "Stopping…"
  and offers no Undo.

  The popup's frame is one scrolling page with the action bar stuck to its end. The bar holds the toast and the cast
  button, measures itself, and the page keeps that much room at its end, so a control you tab to is never hidden under
  the bar. Its top line shows only while there is more page under it, in browsers that can tell.

  The popup's frame is the container of anything positioned inside it, so a visually hidden label no longer makes the
  document scroll as well as the frame, and the room picker's fold spans its card, so a room's start level is no longer
  cut off at the fold's edge.

  The old speaker selector and speaker volume row are gone, now that the popup is built from these parts.

  When the focused control goes away, the popup moves focus to the next one; the set form opens on its name field and
  focuses it again when the name is missing. Without the cast button the popup keeps its padding at the end, and the
  button's band reaches the window's edge. "Add a room" scrolls its list into view above the add mode's buttons. A cast
  tile opens and shuts at once with its head row and Stop in one place, and turns its chevron like every other fold. A
  chosen room whose level is not known shows "…" on a button that opens the slider at the limit. A joining room keeps
  its columns, greyed. A set's room count sits at the row's end in quieter text, notice lines line up with their first
  line, and WebKit no longer shows a second clear button in the search.

- [#241](https://github.com/brew-lab/thaumic-cast/pull/241) [`d859dd1`](https://github.com/brew-lab/thaumic-cast/commit/d859dd162638a89695000a88d444021b2fe26732) Thanks [@skezo](https://github.com/skezo)! - feat(extension): show an update as a mark on Settings

  When a newer desktop app or server is out, the popup no longer adds a row under the Cast button, which on a long
  popup sat below the fold. Instead the Settings button at the top carries a small dot and is named "Settings, update
  available", with that name shown when you point at it or focus it. Pressing it opens Settings at About, where the
  update's link is. Nothing in the popup moves when the mark appears. The popup's frame has no end row any more.

- [#241](https://github.com/brew-lab/thaumic-cast/pull/241) [`d859dd1`](https://github.com/brew-lab/thaumic-cast/commit/d859dd162638a89695000a88d444021b2fe26732) Thanks [@skezo](https://github.com/skezo)! - feat(ui): mark an IconButton

  An icon button can now carry a mark: a small dot in the theme's primary colour at its top corner, ringed so it
  reads on the button and on the page, in light and dark. It says something waits behind the button, such as
  Settings while an update exists, and the button's name says it too. The dot sits outside the shape that focus and
  a press draw, so neither cuts it off, and nothing moves when it appears. The catalogue draws it in every state.

### Patch Changes

- [#233](https://github.com/brew-lab/thaumic-cast/pull/233) [`6bb6bd8`](https://github.com/brew-lab/thaumic-cast/commit/6bb6bd8c4d2f57701edf82c7a37eca6ed8b5d9dd) Thanks [@skezo](https://github.com/skezo)! - feat(core): start every cast at a safe volume

  A cast used to start at whatever level the room was left at, so after a party it could start at 80 or more. Now a cast starts no louder than 30. A room that is louder is turned down to 30 just before the cast plays; a quieter room is left where it is, so Thaumic Cast never turns a room up to start. In a Sonos group each room is set on its own, so a quiet room stays quiet. If a room's level cannot be read, it starts at 30. The limit is in Settings, under "Start no louder than", where it can be changed or turned off.

  Before you cast, the volume slider for each speaker no longer changes the speaker straight away, so you can no longer turn up someone else's music by accident. It now sets the level the cast will start at, and shows the room's level now beside it, for example "Now 72; starts at 30". A level you set here is used for this cast only, and can be above the limit.

  A speaker shows "…" until it has reported its level, instead of a made-up 50. A speaker with a fixed line-level output, such as a Port, shows "Fixed" instead of a slider, and its volume is never changed.

  The start level is set by the desktop app or server, so both behave the same. An older desktop app or server ignores it and starts casts at the room's level, as before.

- [#238](https://github.com/brew-lab/thaumic-cast/pull/238) [`08418b9`](https://github.com/brew-lab/thaumic-cast/commit/08418b9126a375f446369a34f2dfc2a4faa1bede) Thanks [@skezo](https://github.com/skezo)! - fix(ui): make the design system hold up on every browser the apps support

  On the desktop app's older WebKit (macOS 13 and Linux), cards keep their edge, fields and lists keep their
  fill, headings and warning glyphs keep their colour, and "Casting now" no longer disappears. The desktop app
  now needs macOS 13 or later with its Safari updates, and the extension Chrome 125 or later; both are written
  into the builds.

  Settings line up: every setting's control ends in one column and its help starts at one edge, and the note
  under a switch keeps clear of it. Pages no longer shift sideways when a scrollbar appears on Windows, and the
  page titles and spacing follow the width of the column rather than the window. Notices and toasts arrive with a
  short fade instead of jumping in, folds open and shut smoothly where the browser can, and a speaker's address
  field grows with the address. Pressing a button on the desktop app no longer changes its corner where the
  browser cannot draw the full shape, numbers that update keep their place, and the popup's setup screens are as
  tall as their content. Nothing changes in how casting works.

  A review pass on top: a pressed or open dropdown keeps showing its value, the theme switch no longer
  covers its label in a narrow settings card, and on/off settings read like every other setting, with
  their help in the same place and size. A paused speaker on the desktop reads "Paused", never the raw
  state, and the badge sits beside the speaker's name. Numbers on the Server page line up with the text
  beside them, a toast's message is never cut short, Undo can show that it is working or that it failed,
  pressing Esc to hide a tooltip no longer dismisses a toast, controls inside a disabled group look
  disabled, a click anywhere in a text field's box puts the cursor in it, and the popup's room list no
  longer scrolls inside itself. "Start no louder than" shows its level.

  After the owner's review: status colours are one set throughout, so every red, amber and green
  matches its swatch, and "Stop all casts" uses the same red as the rest. Buttons keep their shape
  when pressed, "Stop" and "Stop all casts" respond to hover, focus and press like every other
  button, and a button that shows "Working…", "Done" or "Try again" fades between them without
  changing size. Ticking a checkbox is one smooth movement, the Appearance switch fades between
  choices, and the dropdown's options take the shape instead of its box. Folds open and shut
  smoothly and the fold's heading stays still when pressed. The speaker reserve reading on the
  desktop is a name and a value over a full-width bar, status dots line up with their words, the
  busy badge is evenly spaced, the radio dot is centred, and the logo sits level with the name in
  the desktop sidebar.

  A last motion pass: a button's old words leave before its new ones arrive, so they never overlap,
  and a button with an icon keeps its words centred. A button that is working keeps its shape under
  the pointer. The Appearance switch's words change colour ahead of their fill, a switch no longer
  stretches when pressed if reduced motion is on, and on macOS and Linux a fold's content fades in
  with its arrow. A fold's heading now shows its hover and press layer.

  The shape follows the press: buttons, switches, checkboxes and the other controls only change
  colour when the pointer passes over them, and take their angled shape when focused from the
  keyboard or pressed. A quick click, a tap, Enter or Space plays the whole change and back, even
  on a button that starts working from that click, and nothing shrinks when pressed. With reduced
  motion on, the shape changes at once. A list opened with the mouse no longer outlines its chosen
  option.

  The Copy button beside an address or a cast's URL changes to "Copied" and back in one smooth
  movement, without a jump at either end, and is no longer a little too narrow for its words. On
  Windows, the dropdown's open list no longer leaves an empty strip down its edge.

- [#241](https://github.com/brew-lab/thaumic-cast/pull/241) [`d859dd1`](https://github.com/brew-lab/thaumic-cast/commit/d859dd162638a89695000a88d444021b2fe26732) Thanks [@skezo](https://github.com/skezo)! - feat(extension): rename and remove saved sets in Settings, and tidy the popup

  Settings has a "Saved sets" section: each set you saved in the popup, with its room count, Rename
  and Remove. Remove takes the set out at once, and Undo puts it back where it was. With no sets, the
  section says where they come from.

  The setup screens use the popup's own spacing and no longer change the popup's height from one step
  to the next. A room row in the popup takes the angled shape when pressed or focused, like every other
  control. A cast with every room in it no longer offers "Add a room", and the cast of the tab you are
  on no longer offers "Go to tab". The open cast's artwork colour reaches the card's edges, and no
  empty line sits under the Cast button.

  A long set name wraps in its row instead of widening the popup, and Escape cancels a rename. The
  Cast button no longer moves when a line appears under it. A popup that takes a room from another
  cast no longer tells you that room left the other cast.

- [#241](https://github.com/brew-lab/thaumic-cast/pull/241) [`d859dd1`](https://github.com/brew-lab/thaumic-cast/commit/d859dd162638a89695000a88d444021b2fe26732) Thanks [@skezo](https://github.com/skezo)! - feat(extension): cast chosen rooms as one Sonos group

  With a desktop app or server that can regroup, a cast now plays exactly the rooms you chose, as one Sonos group,
  and nothing else. A chosen room in a Sonos group with rooms you did not choose leaves that group until you stop,
  and the companion puts it back afterwards. The line under the Cast button says so once: "Kitchen leaves its Sonos
  group until you stop." When a chosen room leads a group that is playing, the rooms it leaves behind carry on with
  their music from the top, and the line says that too: "Music in Patio starts again from the top." The line then
  leaves out "Whatever the speaker is playing will stop.", which beside it would read as if Patio stopped. A cast's
  volume
  moves every room in its group together, and Undo after Remove puts a room back at its own level. A room that did not
  start shows "did not join" on its row, with Try again. Resuming from the tab names the cast's rooms again, so a room
  someone moved elsewhere is left where it is. A room of the cast is named by its room in notes and in the toolbar
  badge's tooltip.

  An older companion cannot regroup, so a cast to it still goes to the chosen rooms' whole Sonos groups, and the line
  still says which other rooms play too. The extension learns which it is talking to from the companion's `/health`,
  read again before every cast.

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

- [#186](https://github.com/brew-lab/thaumic-cast/pull/186) [`a8b9c7e`](https://github.com/brew-lab/thaumic-cast/commit/a8b9c7eb726234e71a5f58888d05e0fd051b106d) Thanks [@skezo](https://github.com/skezo)! - fix(ui): restore button group spacing and let the theme change without a reload

  Two faults, both a class name that never resolved. The button group built its spacing and alignment class names from
  its props, but the build exports only camel-case keys while the stylesheet uses hyphenated names, so those lookups
  found nothing and were dropped, leaving every wizard screen without spacing or alignment. The sidebar brand icon had
  the same fault. Separately, the page wrote an inline colour scheme before painting, which outranks the stylesheet that
  maps the theme attribute, so once written it never changed and choosing a theme had no visible effect until a reload.
  The attribute alone is enough, because the style block on the same page already maps it.

  Closes [#110](https://github.com/brew-lab/thaumic-cast/issues/110)
  Closes [#114](https://github.com/brew-lab/thaumic-cast/issues/114)

- [#239](https://github.com/brew-lab/thaumic-cast/pull/239) [`2c6fcaf`](https://github.com/brew-lab/thaumic-cast/commit/2c6fcaf8b317333dbcc09261be9f2fd077b8a6ce) Thanks [@skezo](https://github.com/skezo)! - feat(ui): export the tokens on their own

  The script tokens can now be imported as `@thaumic-cast/ui/tokens`, without the components, Preact or any CSS, so the extension's background can read the toolbar badge's colours from the design system. A test keeps the generated `tokens.ts` free of imports.

- Updated dependencies [[`2c6fcaf`](https://github.com/brew-lab/thaumic-cast/commit/2c6fcaf8b317333dbcc09261be9f2fd077b8a6ce), [`44b237d`](https://github.com/brew-lab/thaumic-cast/commit/44b237db820faf85e1bf5eaea043888888e64386), [`2c6fcaf`](https://github.com/brew-lab/thaumic-cast/commit/2c6fcaf8b317333dbcc09261be9f2fd077b8a6ce), [`6bb6bd8`](https://github.com/brew-lab/thaumic-cast/commit/6bb6bd8c4d2f57701edf82c7a37eca6ed8b5d9dd), [`2c6fcaf`](https://github.com/brew-lab/thaumic-cast/commit/2c6fcaf8b317333dbcc09261be9f2fd077b8a6ce), [`644a955`](https://github.com/brew-lab/thaumic-cast/commit/644a955100483f155176286cf74fa0bb2627a400), [`dd1bf05`](https://github.com/brew-lab/thaumic-cast/commit/dd1bf057cdffa6806ee3bad2fc55a4e5c3843564), [`0a7c6b6`](https://github.com/brew-lab/thaumic-cast/commit/0a7c6b67299c159410efc4eaa8d27a1c922d653e), [`d859dd1`](https://github.com/brew-lab/thaumic-cast/commit/d859dd162638a89695000a88d444021b2fe26732), [`a079ad9`](https://github.com/brew-lab/thaumic-cast/commit/a079ad9f678a2ad25553e0d0b6c3c90e427989da), [`f833ba4`](https://github.com/brew-lab/thaumic-cast/commit/f833ba45fb46cddcc4802af40fc3977b907a50fa), [`b36848b`](https://github.com/brew-lab/thaumic-cast/commit/b36848b0eeaa0d4b0c9f902debd9e55b9143a4e7), [`d859dd1`](https://github.com/brew-lab/thaumic-cast/commit/d859dd162638a89695000a88d444021b2fe26732), [`2c6fcaf`](https://github.com/brew-lab/thaumic-cast/commit/2c6fcaf8b317333dbcc09261be9f2fd077b8a6ce), [`ca7f19d`](https://github.com/brew-lab/thaumic-cast/commit/ca7f19dfa1385c2a4bd7cb1d18074a8d9f5215ad), [`d8efc83`](https://github.com/brew-lab/thaumic-cast/commit/d8efc833ce9a7dab677cea30d9e490fbe72c25f6), [`67f86db`](https://github.com/brew-lab/thaumic-cast/commit/67f86db9a81fc1c9ed6850af9a3c91a66c0d350d), [`c219d46`](https://github.com/brew-lab/thaumic-cast/commit/c219d4693303063d6934d3cec8d28d20b980b97e), [`09d86b0`](https://github.com/brew-lab/thaumic-cast/commit/09d86b033f9b2db0408d7066839a25a9a158db1d), [`6ed39cd`](https://github.com/brew-lab/thaumic-cast/commit/6ed39cd3c0ae72678b56fa1a2f72ee650d650674), [`2c6fcaf`](https://github.com/brew-lab/thaumic-cast/commit/2c6fcaf8b317333dbcc09261be9f2fd077b8a6ce), [`602c9ee`](https://github.com/brew-lab/thaumic-cast/commit/602c9ee2ff71b41f4added085bda4a48c1d1154c), [`0a1e5cf`](https://github.com/brew-lab/thaumic-cast/commit/0a1e5cf39cfdf535d7030182a32b121660c3bbba)]:
  - @thaumic-cast/protocol@0.6.0

## 3.0.0

### Minor Changes

- [#71](https://github.com/brew-lab/thaumic-cast/pull/71) [`a01a1c4`](https://github.com/brew-lab/thaumic-cast/commit/a01a1c4bd61ff52bddb5d244ca8361fd0a127351) Thanks [@skezo](https://github.com/skezo)! - Add fixed volume detection for Sonos speakers with line-level output

  Sonos devices like CONNECT and Port have fixed line-level output where volume cannot be adjusted via API. This change detects and handles these speakers:
  - Parse `OutputFixed` from GENA GroupRenderingControl notifications
  - Propagate `fixed` state through the event system alongside volume updates
  - Disable volume controls in the UI for fixed-output speakers
  - Add `disabled` prop to `VolumeControl` and `SpeakerVolumeRow` components

  When a speaker has fixed volume, the volume slider and mute button are visually disabled and non-interactive.

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

- [#70](https://github.com/brew-lab/thaumic-cast/pull/70) [`f958485`](https://github.com/brew-lab/thaumic-cast/commit/f9584852e7e2649435ff231d01352195c65c59d9) Thanks [@skezo](https://github.com/skezo)! - Fix volume slider jumping from stale server responses

  Add interaction cooldown to the VolumeControl component that blocks external volume updates while the user is actively dragging the slider. Previously, server round-trip responses could override user input mid-drag, causing the slider to jump unexpectedly.
  - Track interaction state from pointer down through a 500ms cooldown after release
  - Queue external volume updates during interaction and apply after cooldown expires
  - Handle edge cases: pointer cancel, keyboard input, release without value change

- Updated dependencies [[`77a19e2`](https://github.com/brew-lab/thaumic-cast/commit/77a19e21150e6b7cd35af44fb3bd6d47edc4d636), [`963170d`](https://github.com/brew-lab/thaumic-cast/commit/963170df0109686df84f47e998b63a1ffb7de6d8), [`b73b49e`](https://github.com/brew-lab/thaumic-cast/commit/b73b49ea5b15d115cb016f395074891c7f77cc95), [`a01a1c4`](https://github.com/brew-lab/thaumic-cast/commit/a01a1c4bd61ff52bddb5d244ca8361fd0a127351), [`153a447`](https://github.com/brew-lab/thaumic-cast/commit/153a44754061c3d57d101d227d4654a863f201d9), [`32ae247`](https://github.com/brew-lab/thaumic-cast/commit/32ae2471d81ace318b32080badceb578b8019ae5), [`facd9e8`](https://github.com/brew-lab/thaumic-cast/commit/facd9e8d5814807947193c2fd8e80b566223bb38)]:
  - @thaumic-cast/protocol@0.5.0

## 2.0.0

### Minor Changes

- [#61](https://github.com/brew-lab/thaumic-cast/pull/61) [`94102c1`](https://github.com/brew-lab/thaumic-cast/commit/94102c1444f01b81c23e43ae4c56c731d71579c3) Thanks [@skezo](https://github.com/skezo)! - Add ButtonGroup component for consistent button grouping with configurable gap, wrap, grow, and alignment options

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

- [#55](https://github.com/brew-lab/thaumic-cast/pull/55) [`3a12f9a`](https://github.com/brew-lab/thaumic-cast/commit/3a12f9aea098aeda38ee956827bb837ce7304e07) Thanks [@skezo](https://github.com/skezo)! - Add hash-based scroll navigation for linking to settings sections

- Updated dependencies [[`36b0c9f`](https://github.com/brew-lab/thaumic-cast/commit/36b0c9fe5af688a692756eb3f066b494d0ae8441)]:
  - @thaumic-cast/protocol@0.3.0

## 1.0.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [[`6921795`](https://github.com/brew-lab/thaumic-cast/commit/6921795b559217b5ee5342852e7c59b80fc858d4), [`7629de4`](https://github.com/brew-lab/thaumic-cast/commit/7629de408fa0aad7e2a454726d890fb32df3d6ee), [`a8ee07e`](https://github.com/brew-lab/thaumic-cast/commit/a8ee07e4510f88292c9452d8ead84ac79a3d077a), [`9ee78a4`](https://github.com/brew-lab/thaumic-cast/commit/9ee78a4240e0abe22ddff3765baf18988de2f9b3), [`823bbf7`](https://github.com/brew-lab/thaumic-cast/commit/823bbf7ec9cf517ddf5e1076c195de7e05b8be2b), [`4082c40`](https://github.com/brew-lab/thaumic-cast/commit/4082c40e2b7bef74d4a46d61c7325880a2169ddd), [`f158fb2`](https://github.com/brew-lab/thaumic-cast/commit/f158fb22a398e1adcac5b344b118a10a9bdcde61), [`b2d3b7c`](https://github.com/brew-lab/thaumic-cast/commit/b2d3b7c146d183217d79c04004f775c8dbedf0c8), [`08673ee`](https://github.com/brew-lab/thaumic-cast/commit/08673eee4b0c1916f7e4abb79caa49effcffc4f7), [`2109faf`](https://github.com/brew-lab/thaumic-cast/commit/2109faf6fa40452a56789ddd08f22ccf08d884bb), [`be4e2d0`](https://github.com/brew-lab/thaumic-cast/commit/be4e2d0c281f8f3ec0cb24cbe00bec55c97808d9)]:
  - @thaumic-cast/protocol@0.2.0

## 0.1.0

### Minor Changes

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

### Patch Changes

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`5943fa0`](https://github.com/brew-lab/thaumic-cast/commit/5943fa0c896b0b6fce4b3c1d25f4cfa435f17a00) Thanks [@skezo](https://github.com/skezo)! - Convert CSS module classes from camelCase to kebab-case
  - Updated all CSS module class selectors to use kebab-case naming convention
  - Updated corresponding TSX imports to use bracket notation for kebab-case properties
  - Enforced by new stylelint selector-class-pattern rule

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`8375f3a`](https://github.com/brew-lab/thaumic-cast/commit/8375f3a50b11df70d428d52a451141257c0b3123) Thanks [@skezo](https://github.com/skezo)! - Add manual server configuration to onboarding and new Disclosure component
  - When auto-discovery fails during onboarding, users can now manually configure the server URL
  - Added collapsible Disclosure component to shared UI package
  - Extracted testServerConnection utility for connection testing
  - Fixed WizardStep content padding to prevent focus outline clipping

- [#35](https://github.com/brew-lab/thaumic-cast/pull/35) [`0bb42f7`](https://github.com/brew-lab/thaumic-cast/commit/0bb42f7d38b93fbb523c87978ef8de066d357b12) Thanks [@skezo](https://github.com/skezo)! - Add manual speaker IP entry for networks where discovery fails
  - Users can manually enter Sonos speaker IP addresses when SSDP/mDNS discovery fails (VPNs, firewalls, network segmentation)
  - IPs are probed to verify they're valid Sonos devices before being saved
  - Manual speakers are merged with auto-discovered speakers during topology refresh
  - Added Input component to shared UI package
  - Manual entry available in onboarding SpeakerStep and Settings view

## 0.0.5

### Patch Changes

- [#32](https://github.com/brew-lab/thaumic-cast/pull/32) [`f633dda`](https://github.com/brew-lab/thaumic-cast/commit/f633dda4f4146a81a908c14a6b79dfc44ca6f674) Thanks [@skezo](https://github.com/skezo)! - ### Bug Fixes
  - **SpeakerMultiSelect**: Allow deselecting all speakers. Previously the last selected speaker's checkbox was disabled to prevent empty selection. Now all checkboxes behave consistently, and the Cast button disables when no speakers are selected.
  - **Speaker Selection**: Fix auto-reselection bug where clearing all speakers would immediately re-select the first one. Auto-selection now only occurs on initial load.
  - **Speaker Ordering**: Sort speaker groups alphabetically by name for consistent UI ordering. Previously order could vary depending on which speaker responded to topology queries.
  - **Speaker Selection Persistence**: Remember selected speakers across popup opens. Selection is stored in chrome.storage.local (device-specific). On load, validates saved IPs against available speakers and falls back to auto-select if speakers are no longer available.

  ### Features
  - **Multi-Speaker Volume Controls**: When multiple speakers are selected, show labeled volume controls for each speaker instead of just the first one. Each control displays the speaker name and allows independent volume/mute adjustment before casting.

## 0.0.4

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

## 0.0.3

### Patch Changes

- [#26](https://github.com/brew-lab/thaumic-cast/pull/26) [`7af7ee1`](https://github.com/brew-lab/thaumic-cast/commit/7af7ee150acabc9812cf74bd8d1c9edd1e8edded) Thanks [@skezo](https://github.com/skezo)! - Extract component styles to CSS modules for better encapsulation
  - Move component-specific styles from theme.css to dedicated CSS module files
  - Add IconButton `solid` variant for filled background buttons
  - Fix ToggleSwitch contrast to meet WCAG 2.1 AA using relative color syntax
  - Fix SpeakerMultiSelect to prevent deselecting the last remaining item

## 0.0.2

### Patch Changes

- [#21](https://github.com/brew-lab/thaumic-cast/pull/21) [`afbe950`](https://github.com/brew-lab/thaumic-cast/commit/afbe95005caa9dea84483d1fea0fe0c93e65e714) Thanks [@skezo](https://github.com/skezo)! - Add video sync opt-in feature with per-cast toggle
  - Add global video sync setting in Options (under Advanced section)
  - Add per-cast video sync toggle in ActiveCastCard popup UI
  - Add StatusChip and ToggleSwitch UI components with WCAG AA compliant colors
  - Status chip backgrounds use dominant artwork color for visual cohesion
  - Fix re-acquire loop caused by coarse alignment triggering play event
  - Disable video sync automatically when cast stops
  - Prevent log spam when video sync enabled on page without video element
