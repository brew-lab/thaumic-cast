---
'@thaumic-cast/extension': patch
---

feat(extension): rewrite the popup, its errors and the first-run tour

The extension's popup, error messages and first-run tour have been rewritten. The button that ends a cast says "Stop",
the heading over running casts says "Casting now", and an error now says what happened and what to do about it, such
as "Nothing answered. Thaumic Cast needs the desktop app or a server running to reach the speakers; start one, then
try again." When a cast stops by itself the reason names the speaker where one was involved. The settings page is unchanged.
