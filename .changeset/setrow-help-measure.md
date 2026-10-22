---
'@thaumic-cast/extension': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/ui': patch
---

fix(ui): end every setting's help on the same line, whatever its control

On the extension's settings page, the help under "When the connection falls behind" ran the full width of the
card, while the help under Smoothing and Frame size beside it stopped before the column of controls. A setting
with a wide control now keeps its help in the same column as every other setting, so all the help in a section
ends on one line. When such a control has to move under the setting's name, it stays at the end of the line,
where every other control ends. Theme, in the extension and the desktop app, follows the same rule.
