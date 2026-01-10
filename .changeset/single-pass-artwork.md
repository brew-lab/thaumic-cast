---
'@thaumic-cast/extension': patch
---

Use single-pass max for artwork selection

- Replaces sort-based selection with O(n) single-pass approach
- Avoids array allocation from Array.from()
- Parses each size only once instead of multiple times during sort
