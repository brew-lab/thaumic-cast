---
'@thaumic-cast/extension': patch
'@thaumic-cast/desktop': patch
---

feat(extension,desktop): hide the language pickers until there is a second language

The Language section in the extension's options and in the desktop app's Settings offered one choice, English. Both are
now hidden, and come back by themselves when a second language ships. Nothing else on either page moves.

The extension used to store English as your language even though you never picked it, which would have kept you on
English after a translation for your browser's language arrived. The stored language can now be "auto", meaning follow
the browser, and that is the default. A stored English is changed to "auto" once, when this version first loads the
settings. After that, English picked in the Language section is your choice and is kept. Every other setting is
unchanged.
