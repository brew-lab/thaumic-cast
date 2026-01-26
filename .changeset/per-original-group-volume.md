---
'thaumic-core': minor
---

Add per-original-group volume control for multi-room streaming

When streaming to multiple Sonos rooms simultaneously, volume can now be controlled independently per original room while maintaining audio sync across all speakers.

**Problem solved:**

Previously, when Room A (4 speakers) and Room B (7 speakers) were joined for synchronized streaming, `GroupRenderingControl` could only adjust all 11 speakers together. Users had no way to make one room quieter than another.

**How it works:**

- Uses `RenderingControl` service to set volume on individual speakers
- Reconstructs original room groupings from `PlaybackSession` data
- Batches volume commands to all speakers that belonged to the same original group
- Executes commands concurrently for responsiveness

**API Endpoints:**

- `GET /api/streams/{id}/original-groups` - List original groups with their speaker IPs
- `POST /api/volume/original-group` - Set volume by speaker IP list (low-level)
- `POST /api/volume/stream-group` - Set volume by stream ID + coordinator UUID (convenience)

**Changes:**

- Add `RenderingControl` service variant for per-speaker volume control
- Add `get_speaker_volume()` and `set_speaker_volume()` to sonos client
- Extend `SonosVolumeControl` trait with per-speaker methods
- Add `OriginalGroup` struct for representing original room groupings
- Add `get_original_groups()` method to `StreamCoordinator`
- Add `speaker_uuid` field to `PlaybackSession` for robust group reconstruction
- Add `set_speakers_volume_impl` helper for concurrent volume commands
- Add comprehensive unit tests for group reconstruction logic

**Robustness:**

Speaker UUIDs are captured at session creation time, making group reconstruction independent of current topology state. This prevents speakers from being silently dropped if topology is transiently empty during a refresh.
