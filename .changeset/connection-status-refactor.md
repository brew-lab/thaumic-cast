---
'@thaumic-cast/extension': patch
'@thaumic-cast/ui': patch
---

Refactor connection status handling for better separation of concerns

**Extension changes:**

- Refactor `useConnectionStatus` hook to use reducer pattern for explicit state transitions
- Remove i18n translation from hook; return error keys for component-level translation
- Separate `WS_STATE_CHANGED` to only carry Sonos state (not connection metadata)
- Add `CONNECTION_ATTEMPT_FAILED` message for explicit connection error handling
- Replace `connected`/`checking` booleans with `phase` enum (`checking`, `reconnecting`, `connected`, `error`)
- Add `canRetry` flag and `retry()` function to connection status
- Add reconnecting state with user feedback when connection is temporarily lost
- Fix race condition where WebSocket connects before `ENSURE_CONNECTION` response arrives

**UI changes:**

- Add inline action button support to Alert component (`action` and `onAction` props)
