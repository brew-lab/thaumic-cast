# @thaumic-cast/protocol

## 0.1.0

### Minor Changes

- [#17](https://github.com/brew-lab/thaumic-cast/pull/17) [`06ffe4f`](https://github.com/brew-lab/thaumic-cast/commit/06ffe4f80c6837314941d1e47115143f3bd44d2d) Thanks [@skezo](https://github.com/skezo)! - Add latency monitoring service for measuring audio playback delay
  - Add GetPositionInfo SOAP call to query Sonos playback position
  - Track stream timing via sample count for precise source position
  - Create LatencyMonitor service with high-frequency polling (100ms)
  - Calculate latency with RTT compensation and EMA smoothing
  - Emit LatencyEvent broadcasts with confidence scoring
  - Foundation for future video-to-audio sync feature
