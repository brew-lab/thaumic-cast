---
'@thaumic-cast/ui': minor
'@thaumic-cast/extension': minor
---

feat(extension): tidy the settings page

Every setting on the settings page now lines up: in each section the switches and lists end on one
edge, including Theme, and a thin line divides one setting from the next. The four Quality choices
read two by two, from Economical to Luxurious, "Finer points" comes before "Saved sets", and "Start
no louder than" comes first in it. Saved sets says where sets are kept and how to make one.

When the settings cannot be saved or loaded, the page now says so at the top instead of failing
silently. While the settings load, the page says so with the moving dots. The "removed" message with
Undo keeps clear of whatever has focus.
