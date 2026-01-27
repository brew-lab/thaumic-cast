---
'thaumic-core': patch
'@thaumic-cast/extension': patch
---

Add opt-in setting for synchronized multi-speaker playback

Synchronized group playback is now controlled by a user setting rather than being automatic. This allows users who prefer independent streams (and are okay with potential audio drift) to keep their existing Sonos speaker groupings unchanged.

**Changes:**

- Add "Synchronize speakers" toggle in Options > Advanced section
- Add `syncSpeakers` field to extension settings (default: false)
- Thread `syncSpeakers` flag through the message chain from extension to server
- Store `syncSpeakers` preference in session for resume/reconnect scenarios
- Server uses independent playback when `syncSpeakers` is false

**Behavior:**

- Setting disabled (default): Each speaker receives independent streams
- Setting enabled: Speakers are grouped via x-rincon protocol for perfect sync
- Single speaker casts are unaffected by this setting
- Resume after pause respects the original sync preference from cast start
