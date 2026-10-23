---
'@thaumic-cast/extension': minor
'@thaumic-cast/ui': patch
---

feat(extension): offer the companion's download wherever nothing answers

With no desktop app or server set up, nothing in the extension said where to get one once the
onboarding was skipped. Settings › About now offers "Download the companion" under "Nothing
connected", and the popup's "No desktop app or server answered" banner offers it beside Try again.
Both open the releases page in a new tab and are gone once a companion connects. The onboarding's
button says "Download the companion" too, since the releases page has the server as well as the
desktop app.
