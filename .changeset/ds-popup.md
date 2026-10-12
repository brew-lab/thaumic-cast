---
'@thaumic-cast/extension': minor
---

feat(extension): rebuild the popup from the design system's components

The popup is one page that scrolls, with the Cast button stuck to its foot, and nothing in it scrolls on its own.
At the top, the mark lights while anything casts and a line says who the popup is talking to; "Asking the
companion again…" replaces the old reconnecting notice. Each running cast is a tile: this tab's is open, with the
artwork's colour behind what is playing, the playback controls, "Go to tab" and a Stop button with a square and
the word "Stop"; any other cast folds to one line and opens when pressed. Stop has no Undo, says the cast has
stopped, and moves the focus to the next Stop or to this tab's card.

You now choose rooms rather than speakers. This tab's card lists sets first (Last cast, any you saved, and
Everywhere from three rooms), then every room, with a home theatre or a stereo pair shown once. From eight rooms
they fold, with a search that never unticks a room. The popup opens with your last cast's rooms chosen, or the
first room nobody else is casting to, and two or more rooms can be saved as a set on this device. Each chosen room
shows the level it will start at, at most your "Start no louder than" limit, and opens a slider to change it for
this cast; nothing touches a speaker before Cast. The button counts rooms ("Cast to 3 rooms"), and the line under it
says which other rooms will play because they are grouped in Sonos with one you chose, and what a cast will
interrupt. A room in a bigger Sonos group shows "…" for its level until Cast.

A cast with several rooms has one volume for all of them, then a fold listing each room's level, Remove (with Undo)
and "Add a room", which plays the cast in the rooms you pick and shows "Joining…" until they answer. Every problem
sits where it happened: a lost connection or an old companion in one banner at the top, a failed Cast in a line
above the button, a room that would not stop or did not join on its own row, a speaker that cut out or may cut out
on its cast, and a room that left a cast as a note in that cast. A cast that ends by itself while the popup is open
says so in a toast that stays until you act, and anything that happened while the popup was shut shows once, in one
"While you were away" line. An older companion now only warns, and Cast stays available.

Keyboard focus never drops to the page: closing a notice or the toast, Undo, and Cancel or Add in the add mode move
it to the next control or back to "Add a room". Undo puts each room back at its own level, never its Sonos group's,
and waits for the removal to land first. A cast played as one Sonos group lists each room once, and its volume also
moves a room added later. Rooms added in quick succession, Undo and "Try again" no longer take each other's answers,
so a room that plays is never reported as not joined. Closing "No reply from the speakers" also clears the toolbar
badge, a room that joined another Sonos group no longer shows its old group's level, and an event seen while the
popup is open stays out of "While you were away" after the background restarts.
