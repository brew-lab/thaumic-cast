---
'@thaumic-cast/core': minor
'@thaumic-cast/extension': minor
'@thaumic-cast/protocol': minor
---

Add WASAPI process-specific loopback capture for browser-wide audio streaming on Windows

Instead of capturing audio per-tab via the Chrome `tabCapture` API, this adds an alternative mode that captures all audio from the browser process at the OS level using Windows Audio Session API (WASAPI) process loopback. Requires Windows 10 build 20348+.

**New packages:**

- `thaumic-capture` crate: platform-gated WASAPI capture library with `WasapiSource`, browser PID discovery via `CreateToolhelp32Snapshot`, and COM/MMCSS-elevated capture thread
- `wasapi-capture` CLI: diagnostic tool that captures N seconds of audio from a PID, outputs Float32 WAV + timing stats for validation

**Core (`thaumic-core`):**

- `capture` module with platform-agnostic `AudioSource`/`AudioSink`/`CaptureHandle` traits and `CaptureSourceFactory` factory pattern (avoids cyclic dependency with `thaumic-capture`)
- `StreamSinkBridge` converts Float32 → PCM16 on the capture thread and pushes into existing `StreamRegistry` pipeline
- `StreamCoordinator::start_capture_stream()` wires up the full capture → stream path
- WebSocket handler adds `START_BROWSER_CAPTURE`, `STOP_BROWSER_CAPTURE`, and async `BROWSER_CAPTURE_ERROR` monitoring (process exit, device disconnect)

**Desktop app:**

- `WasapiCaptureFactory` bridges `thaumic-capture` into core's factory trait
- `get_capture_capabilities` Tauri command exposes platform availability to frontend

**Extension:**

- New `captureMode` setting (`tab` | `browser`) with UI toggle in Advanced Settings
- Mode exclusivity enforcement (tab and browser capture cannot coexist)
- Browser capture flow: sends `START_BROWSER_CAPTURE` over WebSocket, server handles capture — no offscreen AudioWorklet needed
- `StreamSession` refactored to handle both capture modes with appropriate teardown
- `BROWSER_CAPTURE_ERROR` handling for graceful recovery on capture failures

**Protocol:**

- `BROWSER_CAPTURE_ERROR` message type with Zod schemas added to WebSocket protocol
