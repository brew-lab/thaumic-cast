---
'@thaumic-cast/ui': patch
---

feat(ui): export the tokens on their own

The script tokens can now be imported as `@thaumic-cast/ui/tokens`, without the components, Preact or any CSS, so the extension's background can read the toolbar badge's colours from the design system. A test keeps the generated `tokens.ts` free of imports.
