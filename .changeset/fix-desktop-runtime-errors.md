---
'@thaumic-cast/desktop': patch
---

Fix runtime errors in Speakers view and Sidebar navigation

- Fix nested anchor tags in Sidebar causing "improper nesting of interactive content" warnings
- Fix TypeScript types to match Rust backend ZoneGroup structure
- Fix undefined coordinator access causing infinite re-render loop
