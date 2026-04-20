---
'@thaumic-cast/extension': patch
---

Eliminate scheduling bottleneck in the FLAC consumer worker drain loop

Removes the 4ms `PROCESS_BUDGET_MS` time cap so the consumer drains every available ring-buffer sample per scheduling slot. On thermally-throttled devices where Chrome reschedules the worker with 100-280ms gaps, the old cap caused a compounding throughput deficit (~12% frame loss on 2-core targets). Adds a matching forward clamp on `nextFrameDueTime` so burst-processed audio time does not register as "ahead of schedule" and yield away the benefit.

Only affects compressed codec paths that still run through `audio-consumer.worker` (FLAC). The PCM-via-MSTP path uses `audio-relay.worker` and is unaffected.
