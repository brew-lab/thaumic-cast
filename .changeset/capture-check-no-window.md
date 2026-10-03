---
'@thaumic-cast/desktop': patch
---

fix(desktop): stop a console window flashing on Windows

To tell the extension whether browser-wide capture can work, the desktop app checked the Windows version by running `reg.exe`, and it did so on every request the extension made to `/health`. Each run flashed a console window for a moment. The version is now read inside the app, so no program starts and nothing flashes. Machines where a policy blocks registry tools now get the right answer too, where before capture was reported as unavailable.
