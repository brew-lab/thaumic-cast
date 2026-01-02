---
'@thaumic-cast/desktop': patch
'@thaumic-cast/extension': patch
---

Fix automated release workflow

- Change changesets config from `linked` to `fixed` to ensure both packages always version together
- Add version mismatch detection in release-pr workflow
- Fix missing Linux build dependencies in release workflow
- Add `tauriScript` config for bun in tauri-action
- Use `workflow_call` to trigger release builds automatically (no PAT required)
