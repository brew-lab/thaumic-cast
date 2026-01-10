---
'@thaumic-cast/desktop': minor
'@thaumic-cast/ui': patch
---

Add manual speaker IP entry for networks where discovery fails

- Users can manually enter Sonos speaker IP addresses when SSDP/mDNS discovery fails (VPNs, firewalls, network segmentation)
- IPs are probed to verify they're valid Sonos devices before being saved
- Manual speakers are merged with auto-discovered speakers during topology refresh
- Added Input component to shared UI package
- Manual entry available in onboarding SpeakerStep and Settings view
