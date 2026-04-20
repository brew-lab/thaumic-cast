# Chrome Tab Audio Capture: LoopbackStream Frame Drop Investigation

## Executive Summary

Chrome's tab audio capture pipeline drops single AudioData frames (~441 samples / 9.188ms at 48kHz) at a rate of approximately 2 per second on low-end hardware (Surface Go, 2-core Pentium Gold 4425Y). **The audio plays to the speakers fine — the tab sounds normal — but the captured stream has missing frames.** This is not an audio rendering underrun. It is a capture pipeline drop occurring inside Chrome's LoopbackStream, downstream of the audio renderer.

This document records the diagnostic methodology, key findings, and evidence that led to this conclusion.

---

## Initial Hypothesis (Disproven)

The investigation began with the assumption that Chrome's audio renderer was failing to produce render quanta on time — a classic underrun caused by the AudioWorklet thread lacking real-time priority. The 128-sample render quantum gives only 2.67ms of processing budget at 48kHz, which was expected to be too tight for a 2-core Pentium under contention.

Two capture paths had been tested prior to this investigation, both exhibiting artifacts:

- **AudioContext path** (createMediaStreamSource → AudioWorklet → SharedArrayBuffer): produces zero-filled audio blocks due to clock domain crossing between the MediaStream and AudioContext clocks.
- **MSTP path** (MediaStreamTrackProcessor → ReadableStream → Worker): eliminates the clock domain crossing but artifacts persisted, suggesting they originated upstream.

The MSTP path was selected for diagnostic investigation because it preserves raw frame timestamps without AudioContext clock interference.

---

## Diagnostic Tooling

A purpose-built PoC Chrome extension and analysis toolkit were created to capture and study the artifacts in isolation.

### PoC Capture Extension (apps/poc-capture/)

A stripped-down Chrome extension focused exclusively on diagnostic capture — no encoding, no server streaming, no concealment. Key design choices:

- **MSTP capture path**: MediaStreamTrackProcessor → ReadableStream → Worker, avoiding AudioContext entirely.
- **Float32 WAV output**: IEEE float format preserving exact sample values (no quantization noise floor masking artifacts).
- **Timestamp gap detection**: every AudioData frame's timestamp compared against expected continuation, with 100µs tolerance.
- **Zero-block detection**: per-frame energy computation flagging near-zero frames during otherwise active audio.
- **Per-frame timing**: inter-read() delta recorded for every frame, producing a complete delivery timing distribution.
- **sampleOffset on every event**: cumulative sample count at each diagnostic event, enabling exact WAV position lookup.

### getUserMedia Constraints

All audio processing disabled to ensure the cleanest possible capture of Chrome's raw output:

```
echoCancellation: false
noiseSuppression: false
autoGainControl: false
voiceIsolation: false     // Chrome 130+ — prevents ML voice isolation on audio thread
channelCount: 1           // mono default, stereo toggle for A/B
sampleRate: unset          // native rate (48kHz), configurable for testing
```

### Analysis Scripts (tools/capture-analysis/)

Four TypeScript scripts (bun runtime, zero dependencies) for offline analysis:

- **analyze-timing.ts**: timing distribution histogram, classification (scheduling jitter / thermal throttling / memory pressure), periodicity detection via FFT, segment trend analysis.
- **analyze-events.ts**: gap/overlap/zero-block event analysis, clustering, burst detection, producer vs consumer vs stream-drop classification via timing cross-reference.
- **analyze-capture-wav.ts**: per-gap raw sample measurements (jump, jumpRatio, localMedianΔ, pre/post RMS), zero-run scanning, quantum alignment check, events-to-WAV cross-reference.
- **analyze-capture-all.ts**: combined runner producing a unified diagnosis.

---

## Key Finding 1: Gaps Are Exactly One AudioData Frame

Every gap detected across multiple capture sessions has a duration of exactly 9188µs — precisely one AudioData frame (441 samples at 48kHz). No partial-frame gaps, no multi-frame gaps (outside of catastrophic outages). Chrome's capture pipeline drops frames atomically.

```
Gap Duration Distribution:
  Min:    9188 µs
  Median: 9188 µs
  P95:    49613 µs (includes outage-adjacent gaps)
  Render quantum: 2667 µs (128 samples @ 48kHz)
```

The gap duration of 9188µs (441 samples) does not align with render quantum boundaries (2667µs / 128 samples). This is the first evidence that the drops are not render-quantum-level underruns but frame-level drops in the capture pipeline.

## Key Finding 2: OS Audio Buffer Size Has No Effect

A controlled A/B test was performed: identical capture conditions, with and without `--audio-buffer-size=4096` on High Performance power plan.

| Metric              | Baseline | --audio-buffer-size=4096 + High Perf |
| ------------------- | -------- | ------------------------------------ |
| Total gaps          | 113      | 115                                  |
| Gap % of capture    | 5.91%    | 5.96%                                |
| Zero blocks         | 45       | 94                                   |
| Timing P99          | 26.5ms   | 20.8ms                               |
| Timing outliers >2x | 5.66%    | 4.03%                                |

The `--audio-buffer-size` flag controls the WASAPI output callback buffer between Chrome's audio renderer and the OS audio endpoint. A 4× larger buffer gives the renderer more time to fill each callback. The timing metrics improved (reduced jitter), confirming the flag works as intended. But gap count and gap percentage were unchanged.

**Conclusion**: the renderer is producing audio successfully. The drops occur after rendering, in the capture pipeline.

## Key Finding 3: Drops Are Producer-Side

The timing cross-reference analysis classified each gap by examining the inter-read() timing delta at the gap's frame index:

- If the timing delta spiked (>3× median), the worker was slow to consume — **consumer-side**.
- If the timing delta was normal but the AudioData timestamp jumped — **producer-side** (Chrome dropped the frame before delivering it).
- If the frame index exceeded the timing array length — **stream backpressure drop**.

Results across captures:

| Capture                      | Producer | Consumer | Stream-drop |
| ---------------------------- | -------- | -------- | ----------- |
| Session 1 (pre-tuning)       | 102      | 11       | 0           |
| Session 2 (with buffer flag) | 102      | 11       | 0           |

The overwhelming majority of drops are producer-side — Chrome's LoopbackStream failed to deliver the frame. The worker and ReadableStream are functioning correctly.

## Key Finding 4: Most Gaps Are Inaudible — Phase Discontinuity Is the Real Artifact

The per-gap raw sample measurements revealed that most gaps splice cleanly at the sample level:

```
jumpRatio distribution across 115 gaps:
  < 1.0:   ~40% (essentially continuous waveform)
  1.0-3.0: ~45% (minor discontinuity, usually inaudible)
  3.0-5.0: ~8%  (audible in quiet passages)
  > 5.0:   ~7%  (clearly audible click/pop)
```

However, even "smooth" splices (low jumpRatio) can be perceptible in sustained musical content. A dropped frame removes 9.2ms of audio — at 440Hz that's 4 full cycles, at 80Hz it's three-quarters of a cycle. Every frequency component in the signal experiences an instantaneous phase jump. The ear perceives this as brief flutter or roughness, distinct from a click.

Representative gap showing a smooth splice that is still a phase discontinuity:

```
Gap #10 at 5.201s:
  before: [ -0.0046,  -0.0190,  -0.0367,  -0.0467]
  after:  [ -0.0474,  -0.0457,  -0.0400,  -0.0321]
  jump=0.0006 jumpRatio=0.1 — sample values align, but 441 samples are missing
```

Representative gap with a severe click:

```
Gap #77 at 38.305s:
  before: [  0.6349,   0.6424,   0.6117,   0.6025]
  after:  [ -0.2711,  -0.2126,   0.1897,   0.1853]
  jump=0.8736 jumpRatio=35.9 — violent waveform discontinuity
```

## Key Finding 5: Catastrophic Outages Are a Separate Problem

Captures consistently show 1-2 extended silence events per minute: clusters of 39-94 consecutive zero-energy frames spanning 2-4 seconds. These correlate with external system load — launching Windows Settings, Task Manager, or other UWP applications on the 2-core Surface Go starves Chrome's processes entirely.

Characteristics:

- All zero-block events in a cluster have exact 0.0 energy and 0.0 maxAbs — true silence, not quiet audio.
- Timestamps remain mostly continuous through the outage (Chrome keeps delivering zero-filled frames).
- A burst of high-jumpRatio gaps occurs at the outage boundary as audio resumes and the pipeline re-synchronizes.
- These outages are an environmental constraint of the hardware, not a Chrome bug.

```
Outage at 46.4-50.0s (94 zero-block frames, ~3.5 seconds):
  ZB#1  t=46.400s energy=0.000e+0
  ZB#2  t=46.413s energy=0.000e+0
  ...
  ZB#94 t=50.025s energy=0.000e+0

Recovery burst (gaps #71-75, all within 0.4s):
  #71 jumpRatio=208.6  (near-silence to full audio)
  #73 jumpRatio=8.1
  #74 jumpRatio=12.2
  #75 jumpRatio=8.8
```

## Key Finding 6: Timing Pattern Is Scheduling Jitter, Not Thermal Throttling

The inter-frame timing distribution shows two modes: a primary peak at ~8.3ms and a secondary peak at ~16.1ms (1.94× the primary). Initial classification flagged this as thermal throttling (two CPU clock states), but the near-exact 2× relationship reveals it is missed-callback doubling — one normal delivery period and one doubled period where a callback was missed and serviced on the next cycle.

```
Classification: scheduling jitter with missed callbacks
Evidence: primary=8.3ms, secondary=16.1ms (1.94× = missed callback doubling)
```

True thermal throttling would show modes at non-harmonic ratios (e.g., 8ms and 11ms representing base clock vs throttled clock).

---

## Architecture of the Problem

Chrome's audio capture pipeline for tab audio:

```
Tab's Web Audio / <audio> / <video>
        ↓
  AudioRendererMixer (renders + mixes all sources in the tab)
        ↓
  Audio Service (WASAPI output stream, MMCSS "Audio" priority)
        ↓  ← audio plays to speakers successfully from here
  LoopbackStream (taps mixed audio for capture)
        ↓  ← FRAME DROPS OCCUR HERE
  MediaStreamTrack (delivered to extension)
        ↓
  MediaStreamTrackProcessor → ReadableStream<AudioData>
        ↓
  Worker (consumer)
```

The LoopbackStream class (in `services/audio/`) uses a `LoopbackSignalForwarder` running on a standard task runner — not the real-time audio thread. It pulls mixed audio from the tab's output stream group via a `DeadlineTimer`. On a 2-core CPU, this non-RT task runner is subject to preemption by Chrome's compositor, GPU process, main-thread JavaScript, and system processes.

The audio renderer and WASAPI output path function correctly (audio plays to speakers without artifacts). The LoopbackStream's non-RT forwarding path is where frames are lost.

---

## What We Tried and What It Told Us

| Intervention                          | Result                                        | What It Proved                                               |
| ------------------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| MSTP instead of AudioContext          | Eliminated clock-domain zeros, gaps persisted | Problem is upstream of capture API                           |
| `--audio-buffer-size=4096`            | No change in gap count, timing improved       | Renderer is not the bottleneck                               |
| High Performance power plan           | Marginal timing improvement                   | CPU throttling is not the primary cause                      |
| `voiceIsolation: false`               | Controlled for ML inference load              | Not the cause (but important to disable)                     |
| Disabling all audio processing        | Controlled for processing overhead            | Not the cause                                                |
| `maxBufferSize` variation on MSTP     | No change in gap count                        | Confirmed producer-side, not consumer-side                   |
| Concealment (tapered step correction) | Fixed clicks but not phase discontinuities    | Splice-point smoothing cannot restore missing audio          |
| Concealment (interpolation bridge)    | 50/110 regressions — created new artifacts    | Extrapolation from 1-2 samples unreliable for music          |
| Concealment (Hann window dip)         | Removes worst clicks, leaves phase skips      | Best available splice-point approach, but inherently limited |

---

## Current Status and Forward Paths

The Hann window dip concealment is deployed as a minimal mitigation, targeting only the worst clicks (jumpRatio > 5). It replaces clicks with brief volume dips, which are perceptually less objectionable. However, it cannot address the ~9ms phase discontinuity inherent in every dropped frame.

Two paths forward are under evaluation:

**WASAPI Native Messaging Host**: a native binary (C++ or Rust) capturing Chrome's audio output directly via WASAPI process-specific loopback, bypassing the LoopbackStream entirely. This eliminates frame drops at the source by running capture on a dedicated MMCSS-registered thread independent of Chrome's scheduling. Engineering cost is a platform-specific native binary with Chrome native messaging integration.

**Predictive Audio Inpainting**: synthesizing the missing 441 samples using spectral analysis of surrounding audio to maintain phase continuity across the gap. This would address the phase discontinuity problem that splice-point concealment cannot solve. Engineering cost is significantly higher, involving spectral estimation, phase prediction, and overlap-add synthesis.

---

## Reproducing the Findings

### Hardware

- Surface Go (1st gen), Intel Pentium Gold 4425Y (2 cores / 4 threads), 8GB RAM
- Windows 10/11, Balanced or High Performance power plan

### Setup

1. Build the PoC extension: `cd apps/poc-capture && npm install && npm run build`
2. Load unpacked extension in Chrome
3. Navigate to a tab playing music (YouTube, Spotify web player, etc.)
4. Open the extension popup, configure capture (48kHz, mono, maxBufferSize=5)
5. Start capture, let it run for 60 seconds
6. Stop capture — WAV, events JSON, and timing binary are saved automatically

### Analysis

```
bun run tools/capture-analysis/analyze-capture-all.ts \
  capture.wav events.json timing.bin
```

### Expected Results on Surface Go

- ~110-120 gaps per 60 seconds (all exactly 9188µs)
- ~90%+ producer-side classification
- 1-2 catastrophic outages if any system UI is opened during capture
- Timing classification: scheduling jitter with missed callbacks

### Expected Results on 4+ Core Hardware

- Significantly fewer gaps (potentially zero under light load)
- No catastrophic outages under normal system activity
- Timing classification: clean or mild scheduling jitter
