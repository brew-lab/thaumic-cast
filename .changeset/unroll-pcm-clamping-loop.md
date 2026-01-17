---
'@thaumic-cast/extension': patch
---

Optimize PCM processor clamping loop with 4x unrolling

- Unroll sample clamping loop by 4 for better instruction-level parallelism
- Replace ternary chain with Math.max/min for JIT-friendly clamping
- Use `s || 0` pattern for branchless NaN-to-zero conversion
- Remove unused clippedSampleCount debug instrumentation
