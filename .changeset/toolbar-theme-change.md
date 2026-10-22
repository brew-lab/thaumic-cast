---
'@thaumic-cast/extension': patch
---

fix(extension): notice when Chrome switches between light and dark

When Chrome switched between light and dark while the popup was shut, the "!" on the toolbar
button kept the old colours until the popup was next opened. The extension now notices the
switch within a couple of seconds, and the toolbar button takes the right colours on its own.
