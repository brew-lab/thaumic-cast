---
'@thaumic-cast/desktop': patch
---

Debounce speaker list updates to reduce UI churn

- Coalesce rapid event bursts (multi-speaker start/stop) into single fetch
- Reduces API calls from 20+ to 5 during typical multi-speaker operations
- 150ms debounce window balances responsiveness with efficiency
