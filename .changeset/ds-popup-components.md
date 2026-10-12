---
'@thaumic-cast/ui': minor
---

feat(ui): build the popup's components from the design system

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
