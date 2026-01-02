---
'@thaumic-cast/extension': minor
---

Add settings page with audio presets and server configuration

- Add options page with server, audio, language, and about sections
- Create preset resolution system that integrates runtime codec detection
- Support auto/low/mid/high/custom audio modes with fallback chains
- Add server auto-discover with manual URL override option
- Move audio configuration from popup to dedicated settings page
- Use shared UI components (Card, Button) from @thaumic-cast/ui
- Replace console.\* with shared logger throughout extension
