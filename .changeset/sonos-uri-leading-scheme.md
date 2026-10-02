---
'@thaumic-cast/core': patch
---

fix(core): rewrite only the leading scheme of an MP3 or AAC speaker URI

MP3 and AAC streams are handed to a speaker as an `x-rincon-mp3radio://` URI. The function that builds it replaced
every `http://` or `https://` in the URL, not only the one at the start, so a URL that carried another address later
on (in a query string, say) had that address rewritten too. It now replaces only the leading scheme. The stream URLs
the companion builds today never contain a second scheme, so the URIs speakers are given do not change.
