---
'@thaumic-cast/extension': patch
---

fix(extension): skip one track per press when two copies of the extension are installed

With two copies of the extension in one browser (a store install beside an unpacked build, or two
unpacked builds), pressing Next or Previous in the popup moved two tracks. Each copy puts its own
media reader in the page, and every reader answered every copy's command, so the page's handler
ran twice. Since the readers started running on YouTube Music, it showed there first. Only the
first reader in a page now answers; it serves every copy, and one press moves one track.
