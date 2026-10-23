---
'@thaumic-cast/desktop': patch
---

fix(desktop): name the browser plainly in the extension step of onboarding

The extension step said the extension "lives in Chrome", though it works in Edge, Brave and other
browsers built on Chrome too. It now says "The half that lives in your browser", lists the
browsers, and its store button reads "Install from the Chrome Web Store".
