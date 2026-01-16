---
'@thaumic-cast/server': minor
'@thaumic-cast/desktop': patch
---

Add manual speaker IP management API to standalone server

**New HTTP Endpoints (thaumic-server)**

- `POST /api/speakers/manual/probe` - Validate IP and probe for Sonos speaker
- `POST /api/speakers/manual` - Add manual speaker (probes before persisting)
- `DELETE /api/speakers/manual/:ip` - Remove manual speaker (with fallback for legacy entries)
- `GET /api/speakers/manual` - List manual speaker IPs

**Server Configuration**

- Add `--data-dir` CLI option and `THAUMIC_DATA_DIR` env var for persistence
- Add `data_dir` field to config.yaml
- Return 503 SERVICE_UNAVAILABLE when data_dir not configured

**Shared Code (thaumic-core)**

- Add `validate_speaker_ip()` with `IpValidationError` enum
- Add `ErrorCode` trait implementation for consistent error codes
- Export `ErrorCode` trait for use by consumers
- Add `set_app_data_dir(impl AsRef<Path>)` for flexible path passing

**Desktop Refactoring**

- Use shared `validate_speaker_ip()` instead of inline validation
- Import `ErrorCode` trait for IP validation error handling
