---
'@thaumic-cast/ui': minor
'@thaumic-cast/extension': patch
---

fix(ui): WCAG 2.1 AA accessibility improvements

**SpeakerMultiSelect**

- Replace incorrect `role="listbox"` with semantic `<fieldset>` and native checkboxes
- Use `<label>` wrapping for proper accessible names

**VolumeControl**

- Add `:focus-visible` styling for slider thumbs (webkit + moz)
- Use logical properties consistently (`block-size` instead of `height`)

**Disclosure**

- Add `aria-controls` and `aria-describedby` (only when elements exist in DOM)
- Add `aria-hidden` to decorative chevron icon

**StatusChip**

- Add Lucide icons to convey status without relying on color alone (WCAG 1.4.1)

**Button/IconButton**

- Fix disabled state contrast using `opacity` + `grayscale` filter to preserve variant identity

**ToggleSwitch**

- Make `aria-label` a required prop for WCAG 4.1.2 compliance

**Wizard**

- Use `aria-labelledby` to reference step title

**Alert**

- Add `aria-hidden="true"` to dismiss button icon

**Card**

- Add `titleLevel` prop for configurable heading hierarchy

**SpeakerVolumeRow**

- Add `role="group"` with `aria-label` for speaker context
- Make label props required for proper i18n support

**Extension**

- Add interpolated i18n keys for speaker-specific accessible labels
