---
'@thaumic-cast/desktop': minor
'@thaumic-cast/extension': minor
---

### Theme System

- Add dark/light mode support with automatic system preference detection
- Adopt mystical violet OKLCH color palette with semantic token layers
- Add motion tokens with reduced-motion support

### Internationalization

- Add i18n framework with English translations for desktop and extension
- Detect system/browser language preferences automatically

### Multi-Group Casting

- Add UI to select and cast to multiple Sonos speaker groups simultaneously

### Onboarding

- Add first-time user onboarding wizard with platform-specific firewall instructions
- Defer network services until firewall warning is acknowledged

### Network Health Monitoring

- Detect VPN/network issues that prevent speaker communication
- Show contextual warnings when speakers aren't responding
- Improve error messaging for no-speakers-found state

### ActiveCastCard Redesign

- Redesign with artwork background and dynamic color extraction
- Add playback controls (play/pause, stop)
- Add view transitions for track changes
- Make title clickable to navigate to source tab

### Shared UI Components

- Add VolumeControl with fill indicator and mute button
- Add IconButton component
- Add Alert component with error/warning/info variants and dismiss support

### Accessibility

- Improve WCAG 2.1 AA compliance across extension UI
- Ensure proper contrast ratios for all text elements

### Fixes

- Stop speakers immediately when stream ends
- Switch speakers to queue after stopping stream
- Clean up existing stream when starting playback on same speaker
- Sync transport state for stream recovery
- Reconnect when server settings change
- Use static branding in DIDL-Lite metadata
