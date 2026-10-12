---
'@thaumic-cast/ui': patch
'@thaumic-cast/extension': patch
---

feat(extension): rename and remove saved sets in Settings, and tidy the popup

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
