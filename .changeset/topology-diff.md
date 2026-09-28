---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
---

feat(core): diff zone topology and report satellite and radio changes

A home-theatre satellite dropping off, a device rebooting or a radio changing channel could explain a stutter the
speaker's buffer does not, but the topology log only ever said "N group(s)", because satellites were folded into their
room. Each GetZoneGroupState answer is now also read as a household that keeps satellites under their primary, zone
bridges, BootSeq, the radio fields and the vanished devices, and compared with the previous answer. A satellite still
in the channel map but no longer listed is reported missing, and returned (with how long it was gone) when it comes
back; reboots, radio changes, newly vanished devices and group joins and leaves are reported too. Each change is
logged, at warn when it points at trouble and with the stream when a speaker it concerns is casting, sent to clients
as a memberChanged topology event, and listed on the next speaker monitor line for that speaker, whose connection
summary counts them. The first answer reports satellites already missing. GENA bodies are never compared, since they
can be stale; their log line now describes the household's shape instead of counting groups.
