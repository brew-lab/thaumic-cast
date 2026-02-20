---
'@thaumic-cast/extension': minor
'@thaumic-cast/core': patch
'@thaumic-cast/protocol': minor
---

Add pipeline instrumentation and streaming resilience improvements

- Add pipeline instrumentation timeline for post-session analysis
- Add encode-in-worklet path with shared worker infrastructure
- Eliminate scheduling bottleneck in consumer worker drain loop
- Set TCP_NODELAY on all accepted connections
- Fix cadence stream termination using Weak<StreamState>
- Filter link-local and VPN interfaces from SSDP discovery
- Rename streamingBufferMs to queueCapacityMs
