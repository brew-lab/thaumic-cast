---
'@thaumic-cast/desktop': minor
'@thaumic-cast/protocol': minor
---

Add latency monitoring service for measuring audio playback delay

- Add GetPositionInfo SOAP call to query Sonos playback position
- Track stream timing via sample count for precise source position
- Create LatencyMonitor service with high-frequency polling (100ms)
- Calculate latency with RTT compensation and EMA smoothing
- Emit LatencyEvent broadcasts with confidence scoring
- Foundation for future video-to-audio sync feature
