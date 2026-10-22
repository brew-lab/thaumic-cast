---
'@thaumic-cast/extension': patch
'@thaumic-cast/ui': patch
---

fix(ui): keep a notice's top padding inside a settings section

A notice inside a settings section, such as the warning on the extension's settings page when "Enter the
address" is chosen with no address saved, lost its top padding, so its words and warning sign sat against the
bar's top edge. It now has the same padding above as below, and its outline in high-contrast mode is whole
again.
