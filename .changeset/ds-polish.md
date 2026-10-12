---
'@thaumic-cast/ui': patch
'@thaumic-cast/extension': patch
'@thaumic-cast/desktop': patch
---

fix(ui): make the design system hold up on every browser the apps support

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
