---
'@thaumic-cast/protocol': patch
'@thaumic-cast/extension': patch
---

feat(protocol): say whether a running cast captures a tab or the whole browser

Each running cast the background reports to the popup now says what it captures, one tab or the whole browser,
so the popup can name a browser-wide cast "Whole browser" with the monitor disc instead of the title of the tab
that happened to start it. A cast reported by an older background is taken to capture one tab, as before.
