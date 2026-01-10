---
'@thaumic-cast/extension': patch
'@thaumic-cast/ui': patch
---

Add manual server configuration to onboarding and new Disclosure component

- When auto-discovery fails during onboarding, users can now manually configure the server URL
- Added collapsible Disclosure component to shared UI package
- Extracted testServerConnection utility for connection testing
- Fixed WizardStep content padding to prevent focus outline clipping
