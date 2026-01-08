---
'@thaumic-cast/extension': patch
---

### Refactoring & Code Quality

- **Route System**: Replace switch-based router with typed route registry and `registerValidatedRoute` factory, eliminating 17 manual `.parse()` calls
- **Message Types**: Reorganize message types by direction (inbound/outbound), remove deprecated types and unused exports
- **Domain Models**: Add `Speaker` and `SpeakerGroupCollection` domain models with type-safe operations
- **Service Layer**: Add `OffscreenBroker` for type-safe offscreen communication, `NotificationService`, and `PersistenceManager`
- **Hook Extraction**: Extract reusable hooks (`useChromeMessage`, `useMountedRef`, `useOptimisticOverlay`, `useStorageListener`, `useSpeakerSelection`, `useExtensionSettingsListener`) to reduce boilerplate
- **Background Split**: Split monolithic `main.ts` files into focused domain handler modules
- **Validation**: Add Zod schema validation for runtime message type safety

### Bug Fixes

- Fix auto-stop notification timer lifecycle (prevent race conditions with rapid notifications)
- Add FIFO eviction to in-memory dominant color cache (prevent unbounded growth)
- Preserve reconnect counter across WebSocket reconnection attempts
- Clean up sessions properly on disconnect
- Preserve `supportedActions` and `playbackState` in metadata validation
- Fix message type shape mismatches

### Performance

- Only poll for video elements when video sync is enabled (eliminates unnecessary `getBoundingClientRect` calls)

### Cleanup

- Remove dead code: `device-config.ts`, `getModeLabel`, `BitrateSelector`, `CodecSelector`, `createDebouncedStorage`, `clearDiscoveryCache`
- Remove unused Battery Status API permission
- Remove redundant `SESSION_HEALTH` message
- Add `noop` utility for explicit silent error handling
