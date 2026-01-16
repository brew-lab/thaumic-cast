---
'@thaumic-cast/extension': minor
'@thaumic-cast/protocol': minor
---

feat(extension): add bit depth selection to audio settings

**Protocol:**

- Add `supportedBitDepths` field to `CodecMetadata` interface for data-driven bit depth validation
- Add `getSupportedBitDepths()` and `isValidBitDepthForCodec()` helper functions
- Update schema refinement and `createEncoderConfig()` to use codec metadata instead of hardcoding FLAC checks

**Extension Settings:**

- Add `bitsPerSample` field to `CustomAudioSettings` schema with Zod validation
- Fix `saveExtensionSettings` to deep merge `customAudioSettings` preserving all fields
- Return Zod-validated settings from `saveExtensionSettings` to ensure React state has defaults applied
- Fix settings hook to use returned validated settings instead of shallow merge

**UI:**

- Add bit depth dropdown in custom mode showing available options per codec (16-bit for most, 16/24-bit for FLAC)
- Add bit depth row to "What You're Getting" display for all presets
- Add streaming buffer row to "What You're Getting" display for PCM codec
- Refactor resolved settings display to data-driven approach for maintainability
