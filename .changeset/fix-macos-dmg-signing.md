---
'@thaumic-cast/desktop': patch
---

fix(desktop): resolve macOS "damaged app" error with ad-hoc signing

- Add explicit ad-hoc signing identity for macOS builds
- Set minimum macOS version to 12.0 (Monterey)
- Add bundle metadata (category, copyright, publisher, description)
