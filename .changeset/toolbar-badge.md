---
'@thaumic-cast/extension': patch
---

feat(extension): show a toolbar badge

The toolbar button now shows "!" when something about your casts needs a look while the popup is shut: the connection lost while casting, no speaker reachable or no reply from the speakers during a cast, a speaker that cut out or may cut out soon, gaps or missing pieces in the sound, or a cast that ended by itself for a fault. It is amber for a warning and red for a problem, in colours that read on a light or a dark toolbar, and its tooltip, which is also its spoken name, says what it is, for example "Thaumic Cast: Gaps in the sound". It never shows a count, and never for something you chose, a speaker that only nearly cut out, an update, or a companion that is simply not running. It clears when the problem ends, when you dismiss its notice, or once the popup has shown you the event.
