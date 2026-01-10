---
'@thaumic-cast/extension': patch
---

Rate-limit healthy stats logging to reduce log noise

- Diagnostic logs now fire immediately when issues are detected (drops, underflows)
- When healthy, logs are rate-limited to once every 30 seconds as a heartbeat
- Reduces log churn from 1/sec to 1/30sec during normal operation
