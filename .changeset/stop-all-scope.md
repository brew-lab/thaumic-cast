---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
---

fix(desktop): show how many machines a stop-all affects

Stopping all streams from the tray ends casts for every connected browser, including ones on other machines, and said
nothing about it. The connection manager now reports distinct remote machines with their connections and streams, so a
browser holding several sockets counts once, and the action warns when more than this machine is affected. A browser
on the same machine reached through its network address is treated as local, so a single user still gets one quiet
click.
