---
'@thaumic-cast/desktop': patch
---

### Bug Fixes

- **Speaker Discovery**: Fix race condition where initial scan could miss speakers if discovery completed before the listener was registered. Now fetches existing groups immediately on mount.
- **Playback Reliability**: Add retry logic with exponential backoff (200ms, 500ms, 1s) for transient SOAP errors (701, 714, 716) when starting playback. Previously, busy speakers would fail immediately requiring manual retry.
- **GENA Subscriptions**: Only subscribe to coordinators for AVTransport. Satellites (Sub, surrounds) and bridges (Boost) don't support AVTransport and were returning 503 errors.

### Code Quality

- Extract shared Tauri event payload types (`DiscoveryCompletePayload`, `NetworkHealthPayload`, `TransportStatePayload`) to `lib/events.ts`
- Add `listenOnce` utility for one-shot event listening with timeout fallback
- Add `SoapError::is_transient()` method to identify retryable errors
- Add `with_retry` helper for SOAP operations with exponential backoff
- Consolidate GENA subscription sync/cleanup functions for coordinators
