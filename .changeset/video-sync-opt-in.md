---
'@thaumic-cast/extension': patch
'@thaumic-cast/ui': patch
'@thaumic-cast/protocol': patch
---

Add video sync opt-in feature with per-cast toggle

- Add global video sync setting in Options (under Advanced section)
- Add per-cast video sync toggle in ActiveCastCard popup UI
- Add StatusChip and ToggleSwitch UI components with WCAG AA compliant colors
- Status chip backgrounds use dominant artwork color for visual cohesion
- Fix re-acquire loop caused by coarse alignment triggering play event
- Disable video sync automatically when cast stops
- Prevent log spam when video sync enabled on page without video element
