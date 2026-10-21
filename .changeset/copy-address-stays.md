---
'@thaumic-cast/ui': patch
'@thaumic-cast/desktop': patch
---

fix(desktop): keep the Server's address as it is shown when copying it

Pressing Copy address on the Server page changed the address shown from `192.168.2.169:49400` to
`http://192.168.2.169:49400`. The shown address now stays as it was; the clipboard still gets the
`http://` address, which a browser or a player can open.
