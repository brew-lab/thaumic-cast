---
'@thaumic-cast/ui': patch
'@thaumic-cast/extension': patch
---

fix(extension): show no live dot on a tab that is not casting

The card for the current tab showed the pink live dot whenever the tab played sound, though nothing
was going out to the speakers. The dot now shows only on a running cast, as it should.
