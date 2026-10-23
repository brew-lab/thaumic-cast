---
'@thaumic-cast/extension': patch
---

feat(extension): say in Settings when a change waits for the next cast

A cast keeps the audio settings it started with, so changing one while it plays changes nothing until the next cast. Settings › Audio now says so while it matters: "The cast playing now keeps its settings. Changes apply from the next cast." It shows only while a cast from this browser is running and a setting that reaches its stream differs from what the cast started with (the quality, codec, bitrate, channels, sample rate, bit depth, smoothing, frame size, what happens when the connection falls behind, or browser-wide capture). It goes away when the settings match the cast again or the casts end, and it is still right in a Settings page opened mid-cast. Theme, language and the other settings that apply at once never bring it.
