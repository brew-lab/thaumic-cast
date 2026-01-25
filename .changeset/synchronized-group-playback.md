---
'thaumic-core': minor
---

Add synchronized multi-speaker playback using Sonos x-rincon protocol

When streaming to multiple Sonos speakers, audio now plays in perfect sync by using Sonos's native group coordination mechanism instead of sending independent streams to each speaker.

**How it works:**

- One speaker becomes the "coordinator" and receives the actual stream URL
- Other speakers become "slaves" that join the coordinator via `x-rincon:{uuid}` protocol
- Slaves sync their playback timing to the coordinator, eliminating drift

**Changes:**

- Add `join_group()` and `leave_group()` SOAP commands to sonos client
- Extend `SonosPlayback` trait with group coordination methods
- Add `GroupRole` enum (Coordinator/Slave) to track speaker roles
- Update `PlaybackSession` with role, coordinator_ip, and coordinator_uuid fields
- Implement coordinator selection (prefers existing Sonos group coordinators)
- Refactor `start_playback_multi` to use synchronized group playback
- Add group-aware cleanup in stop methods (slaves unjoin, coordinator cascade)
- Fix `get_expected_stream` to handle x-rincon URIs correctly for slaves
- Add `get_member_uuid_by_ip` helper for UUID lookup across all group members

**Behavior:**

- Single speaker: unchanged (no grouping)
- Multiple speakers: synchronized via x-rincon protocol
- Fallback: legacy sequential playback if UUID lookup fails
- User's existing Sonos groups are restored after streaming ends (best-effort)
