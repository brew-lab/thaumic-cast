---
'@thaumic-cast/ui': minor
'@thaumic-cast/extension': minor
'@thaumic-cast/desktop': minor
---

feat(ui): build the settings pages and the notices from the design system's molecules

The design system's shared molecules are built and drawn on the catalogue page in every state, in light and
dark: fields, settings rows, choice groups, copy and address fields, readouts, folds, empty states, notices,
toasts, page titles, wizard steps and cards. The extension's settings page and the desktop app's Speakers,
Server and Settings views now use them: settings sit in rows with their help beside or under them, choices
flow into columns, and every page has one large title. The server address and speaker address tests are one
control that only shows busy on its button, says "Try again" when nothing answers, and now says straight away
when a server address cannot be right. Copy buttons say "Copied" for a moment after a copy, and
the Server page's copy button has a name at last. Every warning keeps its place but is read out by screen
readers once, from one place per screen, instead of interrupting. Nothing changes in how casting works.

Controls are now compact by default: buttons, fields and dropdowns are 32 px tall everywhere, and only the action a
screen exists for (Stop all casts and Ask again, the setup steps, Cast) stays large. On the desktop app and under touch
every control still answers a press across 44 px, so nothing got harder to hit on a touchscreen. Addresses you copy
are shown as plain text with a small Copy button beside them, the theme switch is the same height as everything
else, and the popup's Mute and Remove buttons are a little larger.
