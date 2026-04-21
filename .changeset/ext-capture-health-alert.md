---
'@thaumic-cast/extension': minor
---

Detect Chrome LoopbackStream frame drops and suggest WASAPI browser capture

Adds an edge-triggered capture-health detector to `StreamSession` that watches `AudioData` timestamp gaps. On low-core Windows devices Chrome's LoopbackStream drops whole audio frames (~9 ms each), which is audible as stuttering; sustained detection surfaces a dismissible popup alert pointing the user at Advanced settings to enable Browser-wide capture, which bypasses LoopbackStream entirely. Degradation and recovery both flow through a new `CAPTURE_HEALTH_EVENT` → `CAPTURE_HEALTH_CHANGED` broadcast modelled on the existing network-health pipeline.

Detection is currently limited to the tab-capture + PCM path (the only worker that emits `gapCount`). Parity for Opus/AAC/FLAC/Vorbis is tracked as follow-up work.
