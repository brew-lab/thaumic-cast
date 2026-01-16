---
'@thaumic-cast/extension': patch
'@thaumic-cast/protocol': patch
---

refactor: make Zod the single source of truth for message types

**Extension Message Schemas (`message-schemas.ts`):**

- Add ~50 Zod schemas for all extension message types
- All types now derived via `z.infer<>` instead of manual interface definitions
- Add schemas for: cast messages, metadata messages, connection messages, WebSocket messages, state updates, control commands, video sync messages

**Extension Messages (`messages.ts`):**

- Remove all manual interface definitions (reduced from 806 to 429 lines)
- Re-export all types and schemas from `message-schemas.ts`
- Keep only directional union types (`PopupToBackgroundMessage`, `BackgroundToOffscreenMessage`, etc.)

**Protocol WebSocket (`websocket.ts`):**

- Convert `WsControlCommand` from manual type union to `WsControlCommandSchema` using `z.discriminatedUnion()`
- Add validation for volume (0-100 range) in SET_VOLUME command

**Extension Settings (`settings.ts`):**

- Convert `SpeakerSelectionState` from manual interface to `SpeakerSelectionStateSchema`
- Update `loadSpeakerSelection()` to use `safeParse()` for runtime validation
