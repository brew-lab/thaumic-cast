---
'@thaumic-cast/ui': patch
'@thaumic-cast/desktop': patch
---

fix(ui): restore button group spacing and let the theme change without a reload

Two faults, both a class name that never resolved. The button group built its spacing and alignment class names from
its props, but the build exports only camel-case keys while the stylesheet uses hyphenated names, so those lookups
found nothing and were dropped, leaving every wizard screen without spacing or alignment. The sidebar brand icon had
the same fault. Separately, the page wrote an inline colour scheme before painting, which outranks the stylesheet that
maps the theme attribute, so once written it never changed and choosing a theme had no visible effect until a reload.
The attribute alone is enough, because the style block on the same page already maps it.

Closes #110
Closes #114
