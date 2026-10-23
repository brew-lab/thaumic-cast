---
'@thaumic-cast/extension': patch
---

fix(extension): reload an unpacked build whose service worker is from an earlier build

Chrome keeps an unpacked extension's service worker and manifest when a new build is copied over the old one, until
Reload is pressed in chrome://extensions, while the popup loads the new files each time it opens. The new popup then
talked to the old worker: Cast failed with the old worker's own check (`payload.speakerIps` expected, from before casts
named rooms), and the old worker discarded the stored language (`'auto'` was new to it). The popup now asks the worker
which build it runs, compares that with the worker loader on disk, and when they differ reloads the extension once
(which closes the popup; the next one casts). A store install is always updated whole, so this never acts there.
