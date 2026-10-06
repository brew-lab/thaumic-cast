---
'@thaumic-cast/ui': minor
---

feat(ui): lay the design system's foundations

The shared UI package now carries the foundations of the design system, written up in `packages/ui/DESIGN.md`. The
design tokens (colours, type, space, shape, motion and sizes, in light and dark) are generated from one table, so they
match the drawings exactly and cannot drift; a test fails if the generated files go stale. The desktop gets a copy of
the colour tokens for the older WebKit on macOS 13. Geist, the heading face, is bundled as one self-hosted file with
its licence, so no build fetches a font from the web. Three small building blocks arrive: a row layout, an icon that
draws only the 33 glyphs the design uses, and one announcer per screen that tells screen readers about results without
repeating itself or speaking when the screen opens. A catalogue page shows all of it in light and dark and is checked
for accessibility in CI, and `bun run lint:ds` reports where the apps still differ from the design system. Nothing in
the extension or the desktop app looks different yet.
