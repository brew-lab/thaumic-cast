---
'@thaumic-cast/ui': minor
'@thaumic-cast/extension': minor
'@thaumic-cast/desktop': minor
---

feat(ui): build the extension and the desktop app from the design system's atoms

The design system's 23 basic parts (buttons, icon buttons, text fields, switches, checkboxes, radio buttons, the
theme picker, dropdowns, sliders, status badges and dots, the busy indicator, artwork, tooltips, chips, headings,
navigation items, the brand mark, the step dots and the reserve meter) are built, each drawn in every state in light
and dark on the catalogue page and checked for accessibility. The extension's popup and settings page and the
desktop app now use them, so both apps take the new look: the purple palette, Geist headings, the bevelled shape on
hover and focus, a clearer focus ring, and Stop shown as a square with the word "Stop" rather than a cross. The
theme in Settings is now a three-way switch (Auto, Light, Dark), the on/off settings are switches, and the desktop's
sidebar narrows below a smaller window width. Results such as "Copied" are read out by screen readers once, from one
place per screen. Nothing changes in how casting works.
