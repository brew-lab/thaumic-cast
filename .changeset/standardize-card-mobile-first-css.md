---
'@thaumic-cast/ui': minor
'@thaumic-cast/desktop': patch
'@thaumic-cast/extension': patch
---

Standardize Card usage and mobile-first responsive design

**Card Component**

- Add optional `icon` prop that renders before the title (inherits title color via `currentColor`)
- Add title text truncation support when Card has icons (flexbox layout with span wrapper)

**Desktop App**

- Update views to use Card's `title`/`icon` props instead of custom header styles
- Convert sidebar and views to mobile-first container queries
- Align Settings toggle layout with Server action row pattern (h4/p structure)
- Server status card shows operational state with colored icon

**Extension**

- Use shared Input component in onboarding for consistent placeholder styling

**Shared Styles**

- Standardize input placeholder opacity (0.7) across apps
