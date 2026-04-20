---
'@thaumic-cast/extension': patch
---

Fix "Session init timed out" when casting with WASAPI browser capture and the PCM codec

After the MSTP PCM pipeline landed, `startWorker()` selected the worker purely by codec: PCM → `audio-relay.worker.ts`, everything else → `audio-consumer.worker.ts`. But `audio-relay.worker.ts` only knows how to consume a transferred `ReadableStream<AudioData>` from `MediaStreamTrackProcessor` — it has no handler for `INIT_BROWSER_CAPTURE`. So when a user enabled WASAPI browser-wide capture with the PCM codec, the offscreen document spawned the MSTP worker, posted `INIT_BROWSER_CAPTURE`, and the message was silently dropped. The WebSocket never opened, the connection promise never resolved, and init timed out.

Worker selection now mirrors the capture-mode branching already present further down in `startWorker()`: the MSTP relay is used only for `captureMode === 'tab'` + PCM, and `audio-consumer.worker.ts` handles all browser-capture sessions regardless of codec. The latter already implements the WS-lifecycle-only browser-capture path, so no worker logic needs to move.
