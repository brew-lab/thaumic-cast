---
'@thaumic-cast/extension': patch
'@thaumic-cast/ui': patch
'@thaumic-cast/desktop': patch
---

Convert CSS module classes from camelCase to kebab-case

- Updated all CSS module class selectors to use kebab-case naming convention
- Updated corresponding TSX imports to use bracket notation for kebab-case properties
- Enforced by new stylelint selector-class-pattern rule
