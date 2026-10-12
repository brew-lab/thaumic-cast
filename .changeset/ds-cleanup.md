---
'@thaumic-cast/ui': minor
---

feat(ui): finish the design-system clean-up

A list of rooms that only shows them, as in the desktop app's setup, is now one shared piece, so
the apps no longer draw that list themselves. The design system's rules are now part of
`bun run lint` and the CI lint job: a colour, size or control that does not come from the design
system fails the check, where it was only reported before. Nothing looks different.
