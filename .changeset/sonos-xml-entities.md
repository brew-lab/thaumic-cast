---
'@thaumic-cast/core': patch
---

fix(core): decode Sonos XML entities exactly once on both parser paths

Attribute values were returned without decoding, so a room named with an apostrophe or an ampersand kept its escaped
form when read from a direct request, while the event path decoded the same document twice and produced malformed XML
that only parsed because of the order Sonos happens to send state variables in. Room names now match on both paths,
and the event path parses fields that follow track metadata instead of stopping at it.
