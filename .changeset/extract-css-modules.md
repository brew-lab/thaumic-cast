---
'@thaumic-cast/ui': patch
---

Extract component styles to CSS modules for better encapsulation

- Move component-specific styles from theme.css to dedicated CSS module files
- Add IconButton `solid` variant for filled background buttons
- Fix ToggleSwitch contrast to meet WCAG 2.1 AA using relative color syntax
- Fix SpeakerMultiSelect to prevent deselecting the last remaining item
