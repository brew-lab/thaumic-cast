---
'@thaumic-cast/desktop': patch
'@thaumic-cast/extension': patch
'@thaumic-cast/ui': patch
'@thaumic-cast/protocol': patch
'@thaumic-cast/shared': patch
---

Bump dev and production dependencies to current major versions: typescript 6, vite 8, i18next 26, react-i18next 17, lucide-preact 1, @changesets/changelog-github 0.6. Adds an `ImportMeta.env` ambient declaration in `@thaumic-cast/shared` so `logger.ts` continues to typecheck under TypeScript 6, and adds `typescript` as a direct devDependency of `@thaumic-cast/extension` so `tsc` resolves locally now that typescript-eslint pins TS 5 and prevents root hoisting.
