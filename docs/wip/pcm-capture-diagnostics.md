# PCM Capture Diagnostics — parked WIP

This folder preserves a work-in-progress patch for an extension-side **PCM pipeline capture** feature: a user-toggleable "Capture PCM pipeline" mode that records 60 seconds of raw audio at each pipeline stage (Float32 from the AudioWorklet, Int16 after quantization) for offline comparison by the analysis scripts in `tools/capture-analysis/`.

## Context

The patch was authored on `skezo/jitter-buffer-v1` against a base that predates the MSTP PR (#96) merge. By the time the jitter-buffer work was split and landed, the producer-side audio path had changed enough that mechanically applying the patch would conflict with the merged MSTP worker. The capture feature itself is still wanted — it's the natural upstream of the offline analysis tooling on this branch — but it needs to be rebuilt against the current `audio-relay.worker.ts`/`stream-session.ts` rather than replayed as-is.

The patch is checked in here so the shape of the feature isn't lost:

- Settings surface: new `pcmCapture: boolean` flag on `CustomAudioSettings` + `StartCaptureMessage`.
- UI surface: toggle in `AdvancedSection.tsx` with i18n keys `pcm_capture_enable` / `pcm_capture_description`.
- Worker surface: capture hooks in `pcm-processor.ts` (Float32), the MSTP relay (Int16), and `audio-consumer.worker.ts` (legacy SAB path). Chunks accumulate into `f32DumpChunks` / `i16DumpChunks` and are flushed on session end.
- Gap instrumentation: `gapCount` / `gapDurationUs` derived from `AudioData.timestamp` comparisons with `expectedNextTimestamp`.

## What's in the patch

`pcm-capture-diagnostics.patch` — the raw stash diff. ~1788 lines. Contains a mix of:

- The PCM capture feature proper (~200 meaningful lines).
- A pre-MSTP version of the MSTP path in `audio-relay.worker.ts` — **superseded** by #96 and should be ignored when re-integrating.
- A stale `bun.lock` entry for the `@thaumic-cast/poc-capture` workspace (now lives on this branch anyway, so the lock entry is redundant).
- One untracked file (`apps/extension/src/offscreen/lpc.ts`) that was unused dead code at the time and should not be re-applied.

## Reviving this

When you want to land the capture feature proper:

1. Work from current `main`'s `audio-relay.worker.ts` (post-MSTP, with the `BufferState` state machine from #106).
2. Graft the capture hooks at three points:
   - `pcm-processor.ts` worklet: copy Float32 samples into a capture buffer when `pcmCapture` is enabled.
   - `audio-relay.worker.ts` MSTP path: after Int16 quantization, push a copy into `i16DumpChunks`.
   - `audio-consumer.worker.ts` SAB path (if still shipping): mirror the Int16 capture.
3. Plumb the `pcmCapture` flag through `StartCaptureMessage` → offscreen broker → worker INIT message.
4. Add the UI toggle + i18n.
5. Decide on the dump sink: file download, `chrome.downloads`, or a background-scripts-triggered share with `tools/capture-analysis/`.

Do **not** reuse the MSTP path changes from the patch — `007c040` + `119dae2` on main are cleaner.
