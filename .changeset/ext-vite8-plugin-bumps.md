---
'@thaumic-cast/extension': patch
---

Bump `@preact/preset-vite` to 2.10.5 and `@crxjs/vite-plugin` to 2.4.0 to silence Vite 8 deprecation warnings — `vite:preact-jsx`, `crx:content-scripts`, and `crx:web-accessible-resources` no longer set the deprecated `esbuild` option. The `rollupOptions`/`rolldownOptions` conflict from `crx:content-scripts` remains and is tracked upstream as crxjs/chrome-extension-tools#1145.
