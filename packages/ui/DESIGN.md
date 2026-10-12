# Thaumic Cast design system v1

This is the design system's one source of truth. Where the earlier design rounds (6 to 12) and their notes disagree with it, this file wins. It also supersedes the earlier canon draft ("canon" below), which it absorbs.

**Annexes.** Three annexes are part of v1. They hold the long material: full sheets, contrast and colour-vision tables, and string tables. They live with the drawings: see the design canvas, Design system v1 page.

- annex 1: foundations and core atoms
- annex 2: the popup
- annex 3: settings and the desktop

Each entry below names its annex section. If an annex disagrees with this file, this file wins; §11 lists the points where that happens.

**The drawings.** Every item is drawn once, in light and in dark, with its status and its full sheet: see the design canvas, Design system v1 page. In this repository, the catalogue page (`packages/ui/catalogue/`, §10 row 6) renders what has been built so far.

**Status.** Every one of the 100 items below is **FINAL**: its spec and its drawing both hold. Work that is still open is build work, not design work, and is listed in §12. Which phase of the build has landed is in §14.

**Audited (round 13 audit).** The critic pass checked coverage against the code inventory and the round 12 drawings, the latest owner decisions, token-only specs, state coverage, WCAG 2.2 AA and simplicity. Its fixes are in place below and listed in §11 (calls 13 to 24). Where an entry gives a number, it is the value of the token named beside it; nothing in a spec is a free value (§2, T-size and the snap list).

Contents:

1. Rules
2. Tokens
3. Foundations
4. Atoms
5. Molecules
6. Components
7. Patterns
8. Layouts and shells
9. Retired
10. Only the design system
11. Consolidation calls
12. Still open
13. Decision log
14. Mapping to `packages/ui` and build order
15. Drawings

---

## 1. Rules (standing, from the owner)

- Keep it simple: use the fewest concepts, states, settings, atoms and strings that get the UX right.
- Shapes appear only on focus and press; hover is colour. Selected, on, casting and current stay calm at rest. Containers and text inputs never reshape; a row that is one pressable control (a Checkbox row, a Radio option, RoomRow `pick`) takes the bevel on focus and press like every other (§11 call 88). Nothing scales on a press (§11 call 77).
- X appears only for a dismiss that has no consequence.
- Stop is the square glyph plus the word "Stop".
- The popup never scrolls inside itself. Long content folds in place.
- WCAG 2.2 AA in both themes, and colour-blind safe: no state is shown by colour alone.
- Logical properties, rem, OKLCH tokens and CSS Modules.
- Headings use Geist 600, self-hosted as woff2 under the OFL in shipped builds. Everything else uses the system body face at 400 and 600.
- Light and dark, both always.
- **Tier rule:** an item may use only items from its own tier or the tiers above it. Code, drawings and strings all use the canonical names below.
- **Token rule:** every colour, length, radius, line, duration, ease, shadow and z value in a component is a token from §2, or a `--{component}-*` token that maps to one. A sheet that gives a raw number is giving that token's value.

## 2. Tokens

Tokens are generated from one table, `packages/ui/scripts/tokens.table.ts` (the values the drawings were made with), into `packages/ui/src/tokens.css` (one `light-dark()` pair each), `packages/ui/src/tokens.ts` and `packages/ui/src/webkit-fallbacks.css`. Nobody types them by hand: `bun run tokens` writes them, and `bun run tokens:check` fails when the committed files are out of date.

### T-colour: colour

**Primitives** are the eight-step ladders, at OKLCH lightness 20, 30, 40, 50, 60, 76, 90 and 95. Components never read a primitive. The ladders show what feeds the system: purple and neutral feed the semantic tokens and magenta the lamp (`--live-lamp` is magenta-60). The status sets are their own primitives, hand-tuned per theme (approach C), so no red, amber, green or blue ladder feeds them.

| Ladder        | Hue, chroma cap | 20        | 30        | 40        | 50        | 60        | 76        | 90        | 95        |
| ------------- | --------------- | --------- | --------- | --------- | --------- | --------- | --------- | --------- | --------- |
| `--purple-*`  | 305, .2         | `#22003a` | `#41006a` | `#620b9b` | `#7f36bc` | `#9d57de` | `#c896ff` | `#e7d5ff` | `#f3eaff` |
| `--neutral-*` | 308, .03        | `#1a1221` | `#322a3a` | `#4c4454` | `#685f71` | `#857c8e` | `#b6acc0` | `#e3d9ee` | `#f4eaff` |
| `--magenta-*` | 350, .22        | `#2f001b` | `#570036` | `#820054` | `#b00073` | `#d72f92` | `#ff7fc0` | `#ffcee4` | `#ffe7f1` |

**Semantic tokens** (light / dark):

| Token                                                | Light                     | Dark                                                         | Use                                                                        |
| ---------------------------------------------------- | ------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `--ground`                                           | `#efe8f5`                 | `#0d0913`                                                    | window, popup body; default `--ring-gap`                                   |
| `--surface`                                          | `#fefdff`                 | `#1b1523`                                                    | cards, rows                                                                |
| `--container`                                        | `#e7dcf1`                 | `#292133`                                                    | rail, inset controls                                                       |
| `--container-high`                                   | `#dfd1eb`                 | `#362c42`                                                    | tracks, tonal IconButton, Artwork ground                                   |
| `--on-surface`                                       | `#1b1122`                 | `#f0edf5`                                                    | text                                                                       |
| `--on-surface-variant`                               | `#4d4356`                 | `#c2b9ce`                                                    | secondary text, icons                                                      |
| `--outline`                                          | `#6e6476`                 | `#91879e`                                                    | control edges                                                              |
| `--outline-variant`                                  | `#cec1d9`                 | `#473d54`                                                    | hairlines; card edge (light only)                                          |
| `--divider`                                          | = `--outline-variant`     | = `--container-high`                                         | Divider, rules in cards, the bar hairline                                  |
| `--inverse-surface` / `--on-inverse-surface`         | `#1b1122` / `#fefdff`     | `#f0edf5` / `#1b1523`                                        | Tooltip, Toast                                                             |
| `--scrim`                                            | `oklch(48% .03 310 / .6)` | `oklch(8% .02 302 / .7)`                                     | Dialog backdrop                                                            |
| `--primary` / `--on-primary`                         | `#6d20a8` / `#ffffff`     | `#c699f8` / `#2b0c44`                                        | filled Button, links, on Switch                                            |
| `--primary-container` / `--on-primary-container`     | `#e7d5ff` / `#4b1d6b`     | `#4b1d6b` / `#ecddff`                                        | current NavItem, chosen option                                             |
| `--secondary-container` / `--on-secondary-container` | `#e8def6` / `#352546`     | `#382d45` / `#e9e0f5`                                        | tonal Button, `pressed`                                                    |
| `--brand-ink`                                        | `#4b1d6b`                 | n/a (headings use `--on-surface`, the mark uses `--primary`) | mark, card headings (light)                                                |
| `--focus`                                            | `#4b1d6b`                 | `#dec3ff`                                                    | the focus ring                                                             |
| `--ring-gap`                                         | = `--ground`              | = `--ground`                                                 | `--surface` on cards, the fill on notices, `--np-card` on the artwork band |
| `--cast-badge` / `--on-cast-badge`                   | `#e7d5ff` / `#4b1d6b`     | `#c699f8` / `#2b0c44`                                        | Badge casting and count                                                    |
| `--live-lamp`                                        | `#d72f92`                 | `#ea4ca4`                                                    | StatusDot live; magenta means live and nothing else                        |
| `--on-danger`                                        | `#ffffff`                 | `#3d090a`                                                    | text on the filled danger Button, on `--danger-ink`; never seeded          |
| `--track`                                            | = `--container-high`      | = `--container-high`                                         | Slider, Meter                                                              |

The **status sets** each have a container, an on-container text colour and an ink (light / dark, dark is approach C, "harmonised"). In light, glyphs take the on-container colour; in dark, they take the ink.

| Set     | Light container / text / ink      | Dark container / text / ink       |
| ------- | --------------------------------- | --------------------------------- |
| danger  | `#ffdbd6` / `#76080c` / `#c2181d` | `#442726` / `#ffe8e7` / `#e88382` |
| warning | `#fde1a7` / `#593301` / `#935d00` | `#664700` / `#f7eddc` / `#ffc251` |
| success | `#c6f2cb` / `#11401c` / `#257c3a` | `#18382b` / `#e0f4ea` / `#64d7aa` |
| info    | `#e7dcf1` / `#1b1122` / `#4d4356` | `#233147` / `#e5efff` / `#8db8ff` |

The token names are `--{set}-container`, `--on-{set}-container`, `--{set}-ink` and `--{set}-glyph` (the on-container colour in light, the ink in dark). **Components never read them by name.** `tokens.css` has one generated `[data-tone='{set}']` block per set, which maps `--tone-container`, `--on-tone-container`, `--tone-glyph` and `--tone-ink` (the blocks hold no theme pair, so `webkit-fallbacks.css` need not repeat them). A component sets `data-tone` and reads `--tone-*`, in one of two pairs: **on its container** (container, on-container, glyph: Notice, NoticeLine, Badge, Button tonal danger and failed) or **on a surface** (the ink, for a glyph, fill, edge or text on `--ground`, `--surface` or `--container`: StatusDot, Clacks answered, Meter low, the invalid and error edges and text, the filled danger Button). `check-ds.ts` rejects a set token read by name outside the token files and the catalogue.

The info set is the Notice and NoticeLine `info` tone (the neutral container in light, blue in dark; §11 call 40). The success container is not used in v1: success is a checklist line (call 37), and only the success ink is read (StatusDot connected, the Clacks' "answered"). The catalogue's #colour draws all four tokens of each set, both pairs and what reads each.

**Component pairs.** Where a component needs a colour that is a different semantic token in each theme, the pair is a generated token too, never a `light-dark()` in a module, so `webkit-fallbacks.css` repeats it: `--field-bg` (`--surface` / `--container`: TextInput, Select), `--listbox-bg` (`--surface` / `--container-high`), `--title-ink` (`--brand-ink` / `--on-surface`: card, page, wizard and empty-state headings, the brand name), `--mark-ink` (`--brand-ink` / `--primary`) and `--card-edge` (`--outline-variant` / transparent). `check-ds.ts` rejects `light-dark(` anywhere but `tokens.css` and `webkit-fallbacks.css`.

Two colour features are not plain tokens:

- **The live gradient.** Light runs from `oklch(42% .2 300)` to `oklch(54% .22 350)`; dark from `oklch(72% .15 300)` to `oklch(78% .15 350)`. Five sRGB fallback stops come first, and the OKLCH ramp (relative colour) sits inside `@supports (color: oklch(from red l c h))`, so the desktop's WebKit floor keeps the sRGB stops instead of an invalid background under transparent text. The drift `--live-shift` runs from −16° to 0° over 8 s and holds under reduced motion. It is used once per screen ("Casting now").
- **The artwork-seeded card.** JS samples the artwork and writes `--art-seed`, clamped, with near-grey seeds swapped for purple-grey. It sets `data-red-guard` for a red seed (hue 20–40, chroma above .1). CSS maps the seed with relative colour:
  - `--np-card`: 92 % / 30 % lightness, chroma capped at .06 / .09
  - `--np-title`: 23 % / 92 %, chroma capped at .06 / .04
  - `--np-rim`: 49 % / 66 %, chroma capped at .14 / .10
  - `--np-sub` and `--np-primary` are mapped the same way.

  Where relative colour is missing (the desktop WebKit floor), the same JS writes `--art-card`, `--art-title` and `--art-rim`. The `--np-*` mapping goes inside `@supports (color: oklch(from red l c h))`, like every relative colour (§10, the floors).

The audits are in the palette accessibility audit (F-a11y) and in the Badge and StatusDot tables in annex 1 (see the design canvas, Design system v1 page).

### T-state: state and disabled

- `--layer` is registered with `@property` as a `<percentage>`. It is 8 % on hover, 10 % on focus and 12 % on press, mixed as `color-mix(in oklch, var(--layer-ink) var(--layer), var(--control-bg))`. `--seg-bg`, `--seg-fg`, `--btn-bg` and `--btn-fg` are registered as `<color>`. A control that reshapes never transitions these registered properties itself: it transitions the painted `background-color` and `color` they produce (a Button's fill on its surface, `::before`), so the layer and a change of state (a segment's choice, a Button's failed fill) still fade over `--dur-effects` and `--dur-change`, because WebKit drops the corner's morph while a registered custom property transitions on the same element (§11 call 79). Controls that never reshape (the Switch track, the Select trigger) still transition `--layer`; Checkbox and Radio rows reshape (§11 call 88) and fade the painted colour.
- **Shape per state:** rest and hover `--radius-control` (hover is the 8 % layer only); focus-visible and press `--shape-bevel` (or `--shape-bevel-short` on 24–28 px controls, `--shape-bevel-small` on the checkbox box, `--shape-bevel-thumb` on the Switch thumb). Focus-visible is the bevel with the ring, which traces it. A press morphs the surface to the bevel over `--dur-shape` and back (from rest, or it is already there when focused); the 12 % layer goes with it, and nothing scales. `corner-shape` is in each shaped control's transition list, so the corner morphs where the engine interpolates it. Selected, on, current and casting keep the rest shape at rest; focus and press shape them like any control.
- **The press hold:** `:active` lasts only as long as the press, so a quick click or tap (about 80 ms) let go before the corner had moved, and Enter never sets it. A press therefore sets `data-pressing` on the control until the later of the release and the end of the morph (`--dur-shape` from the first frame drawn with the press, then one frame of the finished bevel), and the styles read it beside `:active`. One shared utility does this (`src/utils/press.ts`, `usePress`): document listeners for pointers (mouse, touch, pen: the primary button) and for the keys the control takes (Enter and Space on a button, Enter alone on a link, Space alone on a checkbox or a radio), added while a pressable control is mounted. A label forwards its press to its control. Disabled and busy controls take no press, a cancelled pointer (a touch that became a scroll) drops it, and it reads no layout. Under reduced motion `--dur-shape` is 0, so the hold ends with the release, but not before one frame has drawn the press (a tap inside one frame still shows it). A press that itself makes a control busy (an `onAction` click, a Switch that saves) keeps its hold: it plays the whole morph and the 12 % layer, then settles to busy (§11 call 78). The Select's options do not use it: choosing closes the list.
- **Disabled** is a rule, not a token pair: ink at 38 % of `--on-surface`, fill or edge at 12 %, and the rest shape `--radius-control`. Checkbox and radio rings are the one exception; they stay at 38 %.

### T-type: type

- **Faces.** Headings and upper-case badges use Geist 600, the only Geist weight shipped. Everything else uses the system stack: `system-ui, -apple-system, 'Segoe UI Variable Text', 'Segoe UI', 'Adwaita Sans', Cantarell, 'Noto Sans', Ubuntu, sans-serif`, at weight 400 or 600 only.
- **Steps:**

  | Token            | Size                             | Line height | Note                            |
  | ---------------- | -------------------------------- | ----------- | ------------------------------- |
  | `--text-1`       | 11 (.6875rem)                    | 16          | fixed                           |
  | `--text-2`       | 12 (.75rem)                      | 16          | fixed                           |
  | `--text-3`       | 13 (.8125rem)                    | 18          | fixed                           |
  | `--text-4`       | `clamp(.875rem, …cqi, .9375rem)` | 20 → 22     | fluid, 14 → 15                  |
  | `--text-5`       |                                  | 22 → 24     | fluid, 16 → 17                  |
  | `--text-6`       |                                  | 26 → 28     | fluid, 20 → 22                  |
  | `--text-7`       |                                  | 30 → 34     | fluid, 24 → 28                  |
  | `--text-8`       |                                  | 38 → 46     | fluid, 32 → 40                  |
  | `--text-4-fixed` | .875rem                          |             | labels in fixed-height controls |

- Sizes are shown in px for reading; every token is written in rem. Line heights are unitless in the generated CSS.
- **Line height** from 14 px up is `round(nearest, 1em + .375rem, .125rem)`. Geist keeps its tracking (−.02em at 32 px up to .06em at 11 px).
- **Weights:** `--weight-body` 400 and `--weight-strong` 600 (the system face); Geist ships 600 only (`--weight-head`). No 500, no `bold`.
- **Numbers** use `--num: tabular-nums` (see `.num`). There is no mono face.

### T-space: space

- `--space-1` to `--space-4` are 2, 4, 8 and 12 px, fixed: control internals. Two fixed half steps sit between them, because the popup rows and notices use them throughout: `--space-2-5` 6 px (.375rem) and `--space-3-5` 10 px (.625rem).
- `--space-5` to `--space-8` are fluid layout steps: 16 → 20, 24 → 32, 32 → 40 and 48 → 64.
- **Snap list** (annex values that are on no step, and the token they become in the build):

  | Annex value          | Where                               | Token                                                                           |
  | -------------------- | ----------------------------------- | ------------------------------------------------------------------------------- |
  | .1875rem (3 px)      | RoomRow block padding               | `--space-1`                                                                     |
  | .5625rem (9 px)      | the artwork band's end padding      | `--space-3-5`, with the rim at `--line-bold` (so the band still lands on 12 px) |
  | 3 px                 | the artwork band rim                | `--line-bold`                                                                   |
  | 5 px                 | the gaps beside the Slider handle   | `--space-2`                                                                     |
  | .125rem between rows | picker and pick lists               | `--space-1` (already a step)                                                    |
  | 16 px                | the desktop Notice's inline padding | `calc(var(--space-4) + var(--space-2))` (`--notice-pad-inline`)                 |

  The drawings show the band at the snapped values; the other snaps are 1 px and are within drawing tolerance.

### T-shape: radius, shape and line

- **Lines:** `--line-hair` 1px (hairlines, control edges at rest, the bar rule) and `--line-bold` 2px (the focus gap and ring, the open, invalid and current edges, the artwork rim). These are the only px values outside `tokens.css` comments, and borders are the one place stylelint allows them.
- **Radii:**

  | Token                                   | Size    | Use                                            |
  | --------------------------------------- | ------- | ---------------------------------------------- |
  | `--radius-pressed` (= `--radius-thumb`) | .25rem  | thumbs, favicon, the checkbox box at rest      |
  | `--radius-control`                      | .5rem   | every control at rest                          |
  | `--radius-group` (= `--radius-notice`)  | .75rem  | segmented track, listbox, notices, popup frame |
  | `--radius-card`                         | 1rem    |                                                |
  | `--radius-dialog`                       | 1.75rem |                                                |
  | `--radius-full`                         |         |                                                |

  Steps 20 and 36 are retired, and so is `--radius-thumb-pressed` (a press takes the bevel). A square icon-only control's bevel is about 30 % of its side (a regular octagon's cut is 29.3 %): IconButton md takes `--shape-bevel`, IconButton sm and the chip × `--shape-bevel-short`.

- **Bevels** (shape tokens, set with `corner-shape` inside `@supports (corner-shape: bevel)`):

  | Token                 | Size               | Use                                           |
  | --------------------- | ------------------ | --------------------------------------------- |
  | `--shape-bevel`       | .625rem            | every other shaped control                    |
  | `--shape-bevel-short` | .5rem              | 24–28 px controls (IconButton sm, the chip ×) |
  | `--shape-bevel-thumb` | .3125rem / .375rem |                                               |
  | `--shape-bevel-small` | .1875rem           | the checkbox box                              |

### T-elev: elevation

```css
--shadow-overlay:
  0 0.125rem 0.375rem light-dark(oklch(20% 0.036 310 / 0.12), oklch(5% 0.02 302 / 0.5)),
  0 0.5rem 1.5rem -0.5rem light-dark(oklch(20% 0.036 310 / 0.36), oklch(5% 0.02 302 / 0.7));
```

- `--shadow-overlay` is the only shadow token. **Only top-layer surfaces use it:** Dialog, Tooltip and the Select listbox.
- Toast is in flow everywhere, so it takes no shadow (see §11).
- Card has no raised kind. In light, elevation is a hairline; in dark, it is the step `--ground` → `--surface` → `--container` → `--container-high`.

### T-motion: motion

- **Durations:** `--dur-fast` 183ms, `--dur-effects` 268ms, `--dur-spatial` 480ms (the Switch thumb's slide and the StepIndicator pill), `--dur-step` 120ms (one Clacks step), and `--dur-stagger` 40ms (between siblings' entrances). `--dur-change` is `--dur-effects` for a change of state that fades or folds (the fold, a Button's state, a segment's choice, a check), and 0 under reduced motion.
- **Timings in script** (`tokens.ts`, not CSS): `TOOLTIP_DELAY_MS` 500, `ANNOUNCE_GAP_MS` 150, `ANNOUNCE_HOLD_MS` 7000 (how long a said message stays in its live region), `BUSY_MIN_MS` 600 (a busy state shows at least this long, so it never flickers), `COPY_CONFIRM_MS` 2000 (how long "Copied" shows; P-copy).
- **Easings:** `--ease-effects` is `cubic-bezier(.3, 0, .1, 1)`; press in and out use it, with no overshoot. `--ease-spatial` is `cubic-bezier(.34, 1.36, .64, 1)`, kept only for the Switch thumb's slide and the StepIndicator pill. The fold uses `--ease-effects` over `--dur-change`, with its content fade and the chevron's turn: an overshoot on a height would push everything below it past its place and back (§11 calls 34, 62).
- **Keyframes** live in `packages/ui/src/motion.css`, inside `@layer base`, and nowhere else: `clack`, `clack-fade` and `drift`. `clack` animates only opacity and scale, so it runs off the main thread; nothing animates a custom property for long (`drift` is once per screen). Entrances use `@starting-style`: Notice, NoticeLine and Toast arrive from opacity 0 and `translate: 0 var(--space-2)` over `--dur-effects` (nothing around them moves), notices in a list of notices (a parent marked `data-notices`, such as the NoticeSlot) staggered by `--dur-stagger` and capped at the third, from `sibling-index()` there or the `index` prop (the inline `--i`; round 7 §7, §11 call 45); none under reduced motion. RoomRow (Phase 3) takes the same entrance with a cap of six.
- **Reduced motion:** shapes swap without morphing (the press hold ends with the release), a press darkens without stretching, a change of state (`--dur-change`) is instant, `drift` holds, `clack` becomes `clack-fade`, entrances do not run, and the theme swaps without its cross-fade.

### T-stack: stacking

- Overlays use the top layer, never `z-index`: `<dialog>.showModal()`, `popover="hint"` tooltips, the `base-select` listbox and any menu.
- In flow there are exactly two values:
  - `--z-raised: 1` paints a part over its sibling inside a component whose root sets `isolation: isolate`.
  - `--z-sticky: 2` is for the StickyActionBar (the popup and the options page) and nothing else.

### T-focus: focus ring

- The ring is `box-shadow: 0 0 0 var(--line-bold) var(--ring-gap), 0 0 0 calc(2 * var(--line-bold)) var(--focus)`, and it traces the current corner shape. It is 2 px of `--focus` at 3:1 or more against `--ring-gap` and the control in both themes (WCAG 2.4.13 is AAA and not required; 2.4.7 and 1.4.11 are met).
- Under forced colours it becomes `outline: var(--line-bold) solid Highlight`. Controls that draw no edge at rest draw one under forced colours (`ButtonText`): the tonal IconButton, the Disclosure trigger, every Button (its transparent edge); the Meter's track takes a `CanvasText` edge and a `Highlight` fill.
- On macOS, `prefers-contrast: more` raises `--outline-variant` to `--outline`.

### T-target: targets, control heights and sizes

`[data-density]` sets md, the hit floor, the gap between hit areas and the selection controls' geometry; it never sets the compact size (F-size). Container queries never set any of them.

| Token          | Popup                                                     | Desktop and options                                    |
| -------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| `--control-xs` | 1.75rem                                                   | 1.75rem                                                |
| `--control-sm` | 2rem                                                      | 2rem (fallback, one value: 2.25rem)                    |
| `--control-md` | 2.25rem                                                   | 2.75rem                                                |
| `--target-min` | 1.5rem                                                    | 2.75rem (the row floor of Checkbox and Radio)          |
| `--hit-min`    | 1.5rem; 2.75rem under `any-pointer: coarse`               | 2.75rem (an `::after` hit area, or the native element) |
| `--gap-target` | `max(var(--space-3), var(--hit-min) - var(--control-xs))` | the same                                               |

Hit areas sit `--gap-target` apart and never overlap; the gap covers hit areas, not drawn edges. Every target is at least 24 px (WCAG 2.5.8) on every surface, and reaches 44 by its hit area in a window and under touch. `--gap-target` is for touch accuracy, not for 2.5.8. A pointer query never changes anything drawn.

**T-size: the fixed geometry.** Each item maps its `--{component}-*` sizes to these, and to nothing else. Values marked "density" change with `[data-density]`.

| Token                                  | Value                             | Used by                                                      |
| -------------------------------------- | --------------------------------- | ------------------------------------------------------------ |
| `--size-dot-sm` / `--size-dot-md`      | .375rem / .5rem                   | StatusDot                                                    |
| `--size-box`                           | 1.125rem, density 1.25rem         | Checkbox box, Radio                                          |
| `--size-badge`                         | 1.25rem                           | Badge height                                                 |
| `--size-chip`                          | 2rem                              | Chip height (desktop only)                                   |
| `--size-switch-w` × `--size-switch-h`  | 2.5 × 1.5rem, density 3 × 1.75rem | Switch track                                                 |
| `--size-track`                         | .75rem                            | Slider and Meter track                                       |
| `--size-handle-w` × `--size-handle-h`  | .25rem × 1.75rem                  | Slider handle; its hit box is `--control-md`                 |
| `--size-art-md` / `--size-art-lg`      | 2.5rem / 3rem                     | Artwork (sm is `--icon-sm`)                                  |
| `--size-nav`                           | 3rem                              | NavItem height, and its square in the narrow rail            |
| `--rail-narrow` / `--rail-wide`        | 4.5rem / 13.5rem                  | Rail                                                         |
| `--popup-inline` / `--popup-block-max` | 22rem / 37.5rem                   | PopupShell (Chrome's popup limits are 800 × 600)             |
| `--page-max`                           | 40rem                             | OptionsShell column                                          |
| `--ch-volume` / `--ch-ms` / `--ch-ip`  | 3ch / 7ch / 15ch                  | `.num` boxes (F-shift); `--ch-count` is retired (call 35)    |
| `--ch-ip-max`                          | 20ch                              | the cap of the IP field that grows with its text (M-address) |
| `--wide-control`                       | 15rem                             | the SettingsRow `wide` cut-off (F-grid)                      |

### T-icon: icon sizes

- `--icon-sm` is 1rem, `--icon-md` 1.25rem and `--icon-lg` 1.5rem. 18 px is retired.
- The `settings` glyph is drawn as Lucide `sliders-horizontal` ("sliders" in the drawings); there is no separate cog.
- The Badge glyph is `calc(var(--icon-sm) * .75)`.
- Glyphs are Lucide at stroke 1.75, in `currentColor`.

### T-chrome: chrome constants (`tokens.ts`)

Colours drawn by Chrome or the OS, generated from the same table as `tokens.css`:

- **Toolbar badge:** the text is "!", never a count.
  - Warning: `--warning-ink` with its text, generated from the set: `#935d00` / `#ffffff` light, `#ffc251` / `#2b1d00` dark.
  - Danger: `--danger-ink` / `--on-danger`, generated from the set: `#c2181d` / `#ffffff` light (6.1:1), `#e88382` / `#3d090a` dark (6.44:1).
- **Tray icon:** idle and lit, each in light and dark.

The TS shape is in annex 1, T-chrome.

### T-comp: component tokens

- Each component defines one block of `--{component}-*` tokens, inside its own module in `packages/ui`. Every one maps to a T-token.
- Variants change component tokens only. A context restyles a component by re-pointing its tokens; for example, a Notice sets `--btn-fg` to its on-container ink.
- The blocks are listed with each item below, and in full in the annexes.

## 3. Foundations

| Id           | Item                     | Spec                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------- |
| F-layers     | Cascade layers           | `@layer reset, tokens, base, components, app, overrides;` comes first in each entry. Every `packages/ui` module is one `@layer components {}` block, and app CSS is `@layer app`. `!important` appears only in forced-colours and reduced-motion resets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| F-pipeline   | Token pipeline and theme | `tokens.css` and `tokens.ts` are generated. A desktop-only `webkit-fallbacks.css` repeats the tokens for engines without `light-dark()`. The theme switch is written **once**, in `packages/ui/src/base.css`: `:root { color-scheme: light dark }`, with `[data-theme="light"\|"dark"]` overriding it. `applyTheme(pref)` lives in `packages/ui/src/theme.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| F-fluid      | Fluid type and space     | `clamp(min, base + k·cqi, max)`. The ramp runs from a 400 px to a 960 px container. min and max are in rem.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| F-containers | Containers and density   | compact is under 25rem, medium is 25–45rem, wide is from 45rem. The containers are `app`, `content`, `card`, `row`, `notice`, `field`, `dialog`, `cluster` and `listbox`. `app` is the surface (the popup and options `body`, the desktop `#app`); `content` is the column the page's type follows (the desktop `main`, the options page column), so fluid steps resolve against it, never the window. Density (`[data-density]`) is how much room the surface has, not the input type: touch is met by hit areas (F-size). State is carried by `data-state`, not by style queries. There is one scroll-state use: the bar hairline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| F-size       | Size and touch           | Five lines. (1) Two sizes: **sm is 32 on every surface and is the default; md is 36 in the popup and 44 in a window.** IconButton is 28 / 32 everywhere. (2) Components fix the sizes of their own parts; apps choose only for loose controls. (3) A loose control is md only if it is the action its view, step, bar or dialog exists for, or sits on that action's line; every other control is sm. (4) Density sets md, the hit floor (`--hit-min`), `--gap-target` and the selection controls' geometry, never sm; selection controls have no size prop. (5) In a window, and under touch in the popup, every target reaches 44 by its hit area, not its box; a value you read is text with a compact Copy beside it, never a box. **Owned sizes:** sm: CopyField, Notice, NoticeLine, Toast, RoomRow, MediaHeader, SettingsRow controls, AddressField in settings; md: WizardStep's actions and AddressField, CastBar, Dialog, the popup set list, the Rooms fold, Add a room, PageHeader's actions, an EmptyState's action. The fallback, if the Surface Go 2 tap test fails, is one token: desktop `--control-sm` 2.25rem.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| F-grid       | Grid and subgrid         | Settings rows subgrid their card from 25rem (label, control and from 45rem help tracks; M-setrow). The card grid is `repeat(auto-fill, minmax(min(100%, var(--track-card)), 1fr))`. The constants, used inside `packages/ui` only and generated with the tokens: `--track-option` 12rem, `--track-card` 18rem, `--wide-control` 15rem, the IP box `--ch-ip`, and the container breakpoints 20rem (`field`), 25rem and 45rem (written as literals inside `@container` queries, where custom properties cannot go; `check-ds.ts` allows only these three). The popup list does **not** use subgrid. A cast's room rows line up by fixed tracks instead: each volume line is `--control-sm`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | the Slider | `--control-sm` (M-roomrow), the same on every row. |
| F-textbox    | `text-box` trim          | `trim-both cap alphabetic` on control labels and headings, at the same outer size (Button, Badge, SegmentedControl, BrandBlock, Chip and Disclosure labels, h1–h6), behind `@supports`. A label that truncates with `overflow` (NavItem) is not trimmed: the trimmed line box would clip its descenders.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| F-shift      | Layout-shift rules       | The scrollbar is one foundation in `base.css`, and stylelint refuses a `scrollbar-*` property or scrollbar pseudo-element anywhere else: every scroller is `scrollbar-width: thin` with `scrollbar-color: var(--outline) transparent` (Safari before 18.2 ignores the width), and every page scroller, marked `data-scroller` (the PopupShell, the compact Wizard, the popup's body, the options document, the desktop main, the full Wizard's content), reserves `scrollbar-gutter: stable both-edges`, so a scrollbar arriving never narrows the page and the content stays centred; a page scroller holding another gives the gutter to the inner one. The root carries the ground as well as the body, so a root page scroller's gutters are the ground and not white; the popup's document is clipped and never scrolls, not even by the fraction of a pixel the shell's height rounds up to, and no gutter is ever the root's, because Chromium sizes a popup to the body and leaves the root's gutters out, which pushed the onboarding off the popup's end by a gutter (§11 call 86); the onboarding's compact Wizard is its own page scroller, as the PopupShell is (§11 call 88). No popover or short list, such as the Select's listbox, is a page scroller: classic scrollbars would reserve an empty gutter (§11 calls 81, 85). A Button fits the state it shows and eases its width on a change, which is real layout, so its neighbours ease with it and nothing jumps (A-button, §11 call 75); its block size and baseline never change with its state, so the line it sits on holds (§11 call 76); a `pressed` Button keeps its check slot. Numbers sit in `ch` boxes: `--ch-volume`, `--ch-ms`, `--ch-ip`. Artwork keeps `aspect-ratio: 1` over its placeholder. A field error replaces the help in the same slot. The Geist fallback is metric-matched. The notice-area row is retired: notices arrive in flow with `@starting-style`. |
| F-grammar    | Interaction grammar      | rest `--radius-control` · hover `--layer` 8 % and no shape · focus-visible `--shape-bevel`, 10 % and the ring (T-focus), which traces the bevel · active the bevel, morphed in and held for the morph (the press hold, T-state), and 12 %; nothing scales · selected calm at rest · disabled (T-state) · busy (Clacks, `aria-busy` + `aria-disabled`, focus stays, at least `BUSY_MIN_MS`) · error (`--line-bold` `--danger-ink` edge, the `danger` glyph, `aria-describedby`). The per-item matrix is below the table. A row that is one control takes the layer, and the bevel on focus-visible and press like any control (§11 call 88). An engine without `corner-shape` (the Safari 16.4 floor) gets colour plus the ring and no shape change at all: the bevel sits inside `@supports (corner-shape: bevel)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| F-a11y       | Palette accessibility    | AA in both themes, with a non-colour cue on every state. The colour-vision audit is the palette accessibility audit plus the annex 1 tables.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| F-icons      | Glyph inventory          | 33 glyphs plus the mark: stop, plus, chevron-down, chevron-start, x, check, copy, refresh, search, external, settings, play, pause, prev, next, volume, volume-off, speaker, cast, music, monitor, server, info, warning, danger, history, bookmark, home, puzzle, shield, sun, moon, contrast. `chevron-start` and `external` mirror under RTL. Annex 1 maps every retired Lucide icon to its replacement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| F-mark       | Mark 1b                  | The idle mark is the octagon outline; while casting it is lit, filled in purple, and never magenta. It is used for the app, the tray (a template image on macOS) and the toolbar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| F-utils      | Utilities                | `Cluster` (`gap` from T-space, `justify`, `stack`; it replaces ButtonGroup and ChipSet). `.num` (tabular, end-aligned in a `--num-ch` box; an inline block, so the box holds on a plain `<span>`). A live number with a column of its own (a volume, the AddressField latency) is end-aligned in its `ch` box; a count in a column of words (the DescriptionList stat counts) is tabular and starts where the words start (§11 call 35). `.mono` (machine text: `ltr`, isolated, breaks anywhere, body face). `.visually-hidden`. Prose links (inside help or Notice text) are styled once in `base.css`: `--primary`, underlined; a stand-alone link is Button `link`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| F-voice      | House voice              | The Discworld layer (round 6): plain first, wry second. Leads are 34 characters or fewer and use no internal nouns. Every NEW string goes through one voice pass before it lands (§12).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### State coverage (every interactive item)

"G" means the F-grammar state, as drawn on the design canvas (Design system v1 page). "n/a" means the state cannot happen, for the reason given. Every cell holds in light and dark, and every focus-visible state keeps the ring clear of the StickyActionBar (2.4.11, L-bar).

| Item                              | Rest · hover · focus-visible · active                                                           | Disabled                                 | Loading                            | Error                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------- | ------------------------------------------------ |
| Button                            | G (danger too)                                                                                  | G                                        | busy, then done / failed           | failed (danger container, "Try again")           |
| IconButton                        | G; `pressed` swaps the glyph                                                                    | G                                        | busy (Clacks replaces the glyph)   | n/a: its result is said, or shown by its row     |
| Switch                            | G on the thumb; the ring on the track                                                           | G                                        | busy ("Launch at login")           | slides back + the row's sentence                 |
| Checkbox                          | G on the row (`--shape-bevel-small` on the box; hover also darkens the ring)                    | G (38 % ring)                            | n/a                                | n/a: no checkbox is validated                    |
| Radio                             | round in every state; layer and ring only                                                       | G                                        | n/a                                | n/a: a ChoiceGroup always has a value            |
| SegmentedControl                  | G per segment; the ring on the track                                                            | G                                        | n/a: theme applies at once         | n/a                                              |
| Select                            | trigger: layer and edge, never reshapes or scales; open = `--line-bold` primary edge; options G | G                                        | busy (Clacks in the trigger)       | `--line-bold` danger edge + Field error          |
| TextInput                         | layer edge on hover; focus `--line-bold` primary; never reshapes                                | G                                        | n/a (the Button beside it is busy) | invalid                                          |
| Slider                            | hover halo; focus ring on the handle; active narrows the handle                                 | G (and "Fixed" reads as text)            | n/a (a joining row is inert)       | n/a                                              |
| Chip ×                            | G (`--shape-bevel-short`)                                                                       | G (while removing)                       | n/a                                | n/a                                              |
| NavItem                           | G; current is calm                                                                              | G                                        | n/a                                | n/a                                              |
| Disclosure                        | G; open is not selected                                                                         | G                                        | n/a                                | n/a                                              |
| ChoiceGroup option                | G on the whole option; the radio stays round                                                    | G                                        | n/a                                | n/a                                              |
| RoomRow `pick` / `cast`           | `pick`: G on the row (its Checkbox); `cast`: G on its controls                                  | unavailable ("No answer")                | joining ("Joining…", inert)        | did not join / still playing + row line          |
| StartLevel button                 | G                                                                                               | n/a: hidden for a fixed output ("Fixed") | "…" while unknown                  | n/a                                              |
| MediaHeader disclosure            | G                                                                                               | n/a                                      | n/a                                | n/a                                              |
| Notice, NoticeLine, Toast actions | G on their Buttons                                                                              | n/a                                      | the action busy                    | the action failed                                |
| CopyField                         | G on the Button                                                                                 | n/a                                      | n/a: the write is instant          | refused: field revealed and selected + info note |
| AddressField                      | G on the Button                                                                                 | G (option not chosen)                    | testing                            | failed ("Try again"), invalid (P-forms)          |
| SetList row                       | G on Rename and Remove                                                                          | n/a                                      | n/a                                | empty name ("A set needs a name.")               |
| Dialog                            | G on its Buttons; initial focus on Cancel                                                       | n/a                                      | the confirm busy                   | the confirm failed                               |

Not interactive, so no states: Badge, StatusDot, Clacks, Icon, Artwork, Tooltip (it follows its trigger), Divider, SectionHeader, BrandBlock, StepIndicator, Meter, Announcer, Card, DescriptionList, EmptyState (its action is a Button), PageHeader.

## 4. Atoms (23)

Each entry gives the API, then kinds and states, sizes, tokens and a11y. The full sheets are in annex 1 (P1) and in the round 7 atom sheets (R7), as amended here; see the design canvas, Design system v1 page.

### A-button · Button: FINAL

- **Absorbs:** ActionButton, SetButton, raw text buttons, the Alert inline action and the "Update available" link.
- **API:**

  ```ts
  kind?: 'filled'|'tonal'|'outline'|'quiet'|'link'; danger?: boolean; size?: 'sm'|'md';
  icon?: GlyphName; trail?: string; pressed?: boolean; expanded?: boolean; description?: string;
  align?: 'center'|'start'; fullWidth?: boolean; flush?: boolean; onAction?: () => Promise<unknown>;
  labels?: { busy?; done?; failed? }; resetKey?: unknown; href?: string; disabled?: boolean; children: string
  ```

  `expanded` adds a trailing `chevron-down` and `aria-expanded`, for disclosure triggers such as "Add a room". `description` adds a second line under the label, for example "Garden is not answering; Study goes alone." on a set. Both are new in v1 (§11). `flush` pulls a quiet Button that starts a text column back by its leading padding and its transparent `--line-hair` border, so its glyph lines up with the text above, and its words with the start of a filled Button's box in the same column (CopyField's Copy, Notice's Details, the Wizard's Skip, which re-points `--btn-pull` to stop on the step's text edge; a context can ask for it by re-pointing `--btn-pull`; §11 calls 90, 91). Its cap is `100%` plus the pull, so its margin box, not its border box, fits the container (§11 call 80). A glyph stays beside its words, centred in the Button's box, and the box fits what the Button shows now (§11 calls 48, 67, 75).

- **Named uses:**
  - Stop: tonal `danger`, `stop` glyph, "Stop".
  - Stop all casts: filled `danger`.
  - Add a room: quiet, with `plus` and `expanded`.
  - Sets: quiet, `pressed`, `align="start"`.
  - Update available (About, in the options page): link, with `external`.
- **States:** rest, hover, focus-visible, active, pressed (on), disabled, busy, done, failed (danger-container, "Try again").
  - **Changing state:** the Button fits what it shows now (idle, busy, done or failed: a glyph and words). On a change it measures itself as it is on screen, renders the new state, measures again and eases `inline-size` and `padding-inline-start` from the old values to the new over `--dur-change` with `--ease-effects` (WAAPI); a change that interrupts another starts from the live width. Nothing is configured: the layout decides which side grows. A free end grows at the end, an end-aligned Button (a SettingsRow, the end of a row) grows towards the start, and a full-width Button never changes width. Neighbours ease with it, because it is layout, not a transform.
    - **The words take turns and never overlap (d = `--dur-change`).** The words it leaves fade out with a `--space-1` rise over 0 to 0.4d, held where they were from the edge that stays, out of the flow and the accessibility tree, and clipped to the box. The words it goes to fade in from `--space-1` below over 0.5d to d, centred and clipped. By 0.5d the box has covered about 84 % of the change, so only a few faint pixels are cut and nothing arrives tail first. Words that do not change do not move; only the glyph in the start slot fades, old out and then new in, on the same clock.
    - **The block size and the baseline hold.** Every state is as tall as the glyph slot, glyph or not, and takes its baseline from the words. The start slot is held out of the flow, in room the unit's start padding keeps for it, so the slot's contents (an icon, the Clacks) never set the baseline and the line the Button sits on never moves, at any frame (§11 call 76).
    - The failed fill cross-fades with the change (the surface's `background-color` and the Button's `color` transition, §11 call 79). Under reduced motion `--dur-change` is 0, so the change is instant; where `animate` is missing it is instant too, and the floors need no fallback (Safari 16.4 animates `inline-size`). There are no timers: done and failed hold until the next press or a change of `resetKey` (CopyField's "Copied" returns after `COPY_CONFIRM_MS`, call 26).
    - Done and failed are said through the Announcer, busy is not said, and focus never moves.
  - A Button with `pressed` set always keeps its check slot; the check fades in when on.
  - Stop and Stop all casts have no busy, done or failed words: while busy they keep their words, the square fades to the Clacks and the width holds, so nothing beside them moves.
  - Danger takes the same hover, focus and press as every kind.
  - The fill, the edge and the state layer are painted on a `::before` under the words, with the Button's radius and corner shape, so the focus ring traces the same shape. Hover is the layer; focus-visible and a press take the bevel, and nothing scales (§11 call 77).
  - Busy ignores a press but keeps hover's layer and, while focused, the bevel and the ring, so a Button that goes busy under the pointer changes only its words (§11 calls 68, 77). The press that makes it busy is not cut short: its hold keeps the bevel and the 12 % layer to the end of the morph, and both then go back together (§11 call 78).
- **Sizes:** sm (the default) and md (F-size). sm is `--control-sm` (32) with `--text-3` and `--icon-sm` on both densities; md is `--control-md` with `--text-4-fixed`, and `--icon-md` in a window. Its `::after` grows the target to `--hit-min` in the block direction.
- **Tokens:** `--btn-bg`, `--btn-fg`, `--btn-edge`, `--btn-h`, `--btn-pad`, `--btn-gap`, `--btn-icon`, `--btn-font`, `--btn-radius`, `--btn-on-*`, `--btn-failed-*`, `--btn-hit`.
- **A11y:**
  - A real `<button>`, or `<a href>` for the link kind.
  - The name starts with the visible words.
  - `pressed` is exposed as `aria-pressed`.
  - Results are said through the Announcer.

### A-iconbtn · IconButton: FINAL

- **Absorbs:** Toggle's mute kind. The cast and sync kinds are retired.
- **API:** `glyph, label (required), kind?: 'quiet'|'tonal', size?: 'sm'|'md', pressed?, pressedGlyph?, busy?, disabled?, tooltip?, mark?, onPress`.
- **Mark:** `mark` says something waits behind the button (Settings while an update exists): an `aria-hidden` `--size-dot-md` dot in `--primary`, ringed by a `--line-bold` outline of `--surface`, at the block-start, inline-end corner, inset by the ring so it stays inside the box. It is drawn by the box, not the shape: the button shows its overflow and has no clip path, so the octagon of focus and press passes under it and nothing moves. Never alone: the name says it too, and a marked button shows its Tooltip. Disabled dims it (`--ib-mark`); under forced colours it keeps its own colours (`forced-color-adjust: none`), as a StatusDot does.
- **Kinds:**
  - quiet: Dismiss, Close, mute, **Remove** (the `stop` glyph, "Remove {{name}}"), previous, next, Back, Clear search, icon-only Copy.
  - tonal: Settings, Play / Pause.
  - There is no filled kind.
- **States:** rest, hover (layer), focus (octagon and ring), active (octagon, held for the morph; no scale), pressed (glyph swap, no fill), disabled, busy (round unless focused; a press does nothing; the press that made it busy plays out).
- **Sizes:** `--control-xs` / `--control-sm` (sm 28 / md 32) on both densities; the glyph `--icon-sm` / `--icon-md`. The hit area comes only from the `::after`, which grows it to `--hit-min`; there is no box floor.
- **Tokens:** `--ib-size`, `--ib-icon`, `--ib-bg`, `--ib-fg`, `--ib-radius`, `--ib-hit`.
- **A11y:**
  - `aria-label` is required.
  - Mute keeps one name, and `aria-pressed` carries its state.
  - On the desktop, the Tooltip shows the name and is `aria-hidden`.

### A-switch · Switch: FINAL

- **API:** `checked onChange label badge? description? note? disabled? busy? error?`. No size: density sets its geometry (F-size). `badge` is a Badge inside the label, after the name, so its words are part of the one name (M-videosync).
- **Layout:** a Switch is its own settings row (M-setrow, §11 call 42): the name on the track's line at the row's label size, the description and note under it at the help size (`--text-2`), and from a 45rem card, in a settings grid, in the help track.
- **Shape:** a `--radius-control` track, `--size-switch-w` × `--size-switch-h` (density sets it), with a `--radius-pressed` thumb inset by `--space-2` (§11 call 36). Only the thumb reshapes (focus and press `--shape-bevel-thumb`, busy too while focused; hover is the layer on the track; a press also stretches the thumb by `--space-2` over `--dur-fast` inside the track, which never changes size, its end edge held still; under reduced motion a press does not stretch), and the ring goes round the track. The slide takes `--ease-spatial`, whose small overshoot (under a pixel) is the one spring in the system (§11 call 69). Off: `--line-hair` `--outline` edge, thumb `--on-surface-variant`; on: `--primary` track, thumb `--on-primary`; the thumb's position is the cue, never the colour alone.
- **States:** busy covers "Launch at login": the Clacks on the thumb, which takes its pressed width so they fit. On error the switch slides back and the row says "The settings were not saved. Try again." Disabled is drawn from the native state, so a disabled fieldset disables its look too (§11 call 38).
- **A11y:** `role="switch"`. The whole row is the target. The name line (the name and its Badge) labels the switch (`aria-labelledby`); the description, note and error describe it, so each is read once. The name line is always `--control-md` tall, so a description coming or going moves nothing.
- **v1 rows:**
  - Options: Video sync, Keep the tab awake, Browser-wide capture, Start no louder than.
  - Desktop: Launch at login, Speaker monitoring, Clock drift correction, Show diagnostics.
  - "Play speakers as one group" is retired (§11 call 84).

### A-check · Checkbox: FINAL

- **API:** `checked, onChange, label, description?, disabled`. No size (F-size). There is no `indeterminate`: nothing in v1 shows a mixed group (audit; §9).
- **Shape:** the row rests on `--radius-control` and takes `--shape-bevel` on focus-visible and press (§11 call 88); a `--size-box` box; rest and hover `--radius-pressed` (hover darkens the ring); focus and press `--shape-bevel-small`. Nothing scales on a press. Checking fades the fill in and grows the check from .6 over `--dur-change`; unchecking reverses it. The check is an even size, so it centres at both densities. Off is a `--line-bold` `--outline` ring (3:1 or more on every ground, 1.4.11); on is a flat `--primary` fill with the `check` glyph in `--on-primary`.
- **Uses:** inside RoomRow `pick`, where the label is the row. It absorbs CheckRow. Checkbox groups are not built until something needs one.

### A-radio · Radio: FINAL

- **Shape:** round (`--radius-full`) in every state, `--size-box`; off is a `--line-bold` `--outline` ring, on adds a `--primary` dot. The dot is `--radio-size / 2.25` rounded down to an even size, so it is centred at both densities. The dot stays round: a ChoiceGroup always has a chosen option, so a shaped dot would be a shape at rest on every settings page (§1), and at 8 px an octagon renders as a soft square, the checkbox's shape (§11 call 63). Native radios.
- **Behaviour:** one tab stop on the checked option; the arrow keys move and check. The option (the label round the radio) takes the layer, the ring and, on focus-visible and press (held), `--shape-bevel` (§11 call 88).
- **Uses:** only inside ChoiceGroup.

### A-segment · SegmentedControl: FINAL

- **API:** `label hideLabel? value onChange options[2–3] disabled?`. No size: the track is `--control-sm` (32) on every surface, and each segment's `::after` reaches `--hit-min` in the block direction.
- **Selected:** `--primary` fill, `--weight-strong` and the `check` glyph (three cues, so never colour alone). The track is `--radius-group`; the ring goes round the track. Choosing cross-fades both segments: the fill over `--dur-change` (`--ease-effects`; instant under reduced motion), and the words over a quarter of it, starting a fifth in, as the fill passes half-way, so the moment a word matches its fill is too short to read as faint (§11 call 70). The weight swaps at once in its reserved cell. Nothing slides.
- **Use:** Appearance (Auto, Light, Dark). It replaces the theme `<select>`. At about 15.5rem it is a wide control in a SettingsRow (§11 call 41). Each label reserves its strong width, so choosing moves nothing (F-shift).
- **States:** per segment, hover is the layer; focus-visible and a press (Space, or a pointer, held for the morph) take `--shape-bevel`, chosen or not, so a press that chooses a segment plays the whole morph; the chosen segment is calm at rest, and nothing scales.
- **A11y:** a radiogroup.

### A-select · Select: FINAL

- **API:** `label value options[{value,label,description?}] size? error? busy? disabled? onChange`. size sm (the default) or md (F-size). The box is drawn by the control's `::before`; the native `<select>` is the hit area, `--hit-min` tall and transparent, centred on the box, so it opens from a press just outside the drawn edge.
- **Build:** `appearance: base-select`. The listbox is a popover with `--shadow-overlay`. The fallback is a native `<select>`.
- **States:** the trigger never reshapes or scales: hover is the 8 % layer and an `--on-surface` edge, focus-visible 10 % and the ring, press 12 %, open a `--line-bold` `--primary` edge. In the customisable listbox, an option takes `--shape-bevel` on keyboard focus and press, chosen or not (where `corner-shape` exists); hover is the layer, and options never scale. A list opened by a pointer shows no focus (no bevel, ring or focus layer) until a key is used, because Chromium focuses the chosen option on every open (§11 call 78). A press on an option is not held (choosing closes the list). The chosen option is calm at rest in `--primary-container`, and its label's cell holds its strong width, so the list never widens. The native list is the OS's. Error has a `--line-bold` danger-ink edge. Busy shows Clacks (only while a choice is being applied, such as the language reloading).

### A-text · TextInput: FINAL

- **Absorbs:** Input, the raw URL input, FindField and the number / IP input.
- **API:** `kind?: 'text'|'address'|'search', value, onInput, size?, placeholder?, disabled?, invalid?, inputMode?: 'url'|'decimal', onClear?`. size sm (the default) or md (F-size). The native `<input>` is the hit area: `--hit-min` tall and transparent inside the drawn box. There is no read-only look: a value that is only read is text (M-copy); AddressField holds the value while it tests with the input's own `readonly`. There is no `busy`: when a field's value is being tested, only the Button beside it shows busy (AddressField; §9). A press anywhere in the drawn box (its padding, the search glyph) focuses the field.
- **Kinds:**
  - `address`: `.mono`, `ltr`, no spellcheck.
  - `search`: leading glyph, a "Clear search" IconButton, Esc clears, and the label is visually hidden.
- **States:** rest (`--line-hair` `--outline`), hover (`--line-hair` `--on-surface`), focus (`--line-bold` `--primary` plus the ring), filled, disabled, invalid (`--line-bold` `--danger-ink` plus `aria-invalid`). It never reshapes.
- **Tokens:** `--input-h`, `--input-bg`, `--input-edge`, `--input-edge-w`, `--input-fg`, `--input-hint`, `--input-pad`, `--input-radius`, `--input-font`.

### A-slider · Slider: FINAL

- **API:** `label min max step value format? centre? mark? readout? onChange`. No size: its geometry is fixed (T-size). `mark` draws a ghost tick at a value that is not the slider's own (StartLine: the room's level now). `readout` shows the formatted value after the track in a box that many `ch` wide (3 for a volume, 7 for ms), "…" while the value is unknown; it is `aria-hidden`, since `aria-valuetext` reads the value (§11 call 49).
- **Geometry:** a `--size-track` track (`--track`, the filled part `--primary`); a `--size-handle-w` × `--size-handle-h` handle in `--primary` with `--space-2` gaps painted in `--ring-gap`. The hit box is `--control-md` tall across the whole track.
- **Uses:** volume (0–100), start level, and trim (±500 ms, centre 0).
- **A11y:** a native `<input type=range>`. `aria-valuetext` reads the formatted value. Page Up and Page Down step ×10. A click anywhere on the track sets the value, so no drag is needed (WCAG 2.5.7). The handle against the track and the ground is 3:1 or more (1.4.11).

### A-chip · Chip: FINAL

- **API:** `<Chip label onRemove removeLabel />`. Input kind only.
- **Size:** `--size-chip` tall on `--radius-control`; the × is an `--icon-lg` square (24 px, so 2.5.8 holds on its own) that takes the IconButton octagon (`--shape-bevel-short`) on focus and press (hover is the layer; nothing scales), with an `::after` hit area to the desktop `--target-min`.
- **Use:** desktop manual speaker addresses, "Remove {{address}}". Delete or Backspace removes a chip, and focus moves to the next one.

### A-badge · Badge: FINAL

- **Absorbs:** StatusChip, SyncStatus, StatusMark and the device pill.
- **API:** `<Badge tone label />`.
- **Tones:**
  - casting: filled `--cast-badge`.
  - neutral: outlined (`--line-hair` `--outline`).
  - warning and danger: container fill plus glyph.
  - busy: outlined plus Clacks.
  - The count tone is retired: nothing in v1 shows a count badge (the header and the toolbar never count; the desktop summary is words). §9.
- **Look:** `--size-badge` tall, Geist caps at `--text-1`, the glyph `calc(var(--icon-sm) * .75)`. A leading glyph sits `--space-2` from the start and from the words; the Clacks, which fills its box to the corners, sits `--space-2-5` from both. The Clacks in a Badge fades and never scales, so its footprint holds still.
- **Rules:** never focusable, never truncated, never magenta, and never colour alone.

### A-dot · StatusDot: FINAL

- **Absorbs:** LiveLamp and the status-dot copies.
- **API:** `state: 'connected'|'checking'|'failed'|'live', size: sm (`--size-dot-sm`) | md (`--size-dot-md`), onFill?` (`onFill` adds a `--line-bold` `--ring-gap` ring, for the live dot on the artwork band). Every state draws in an `--icon-sm` square, its mark centred, so the words beside a column of dots start at one edge.
- **Shapes:** a dot, Clacks, circle-x, the magenta lamp. `off` folds into `failed`.
- **Rules:** always beside words, `aria-hidden`, never animated.

### A-clacks · Clacks: FINAL

- **What:** the only busy indicator. Three open shutters walk the snake path, one step per `--dur-step`. "Answered" lights all eight in `--success-ink`. Under reduced motion it becomes `clack-fade`. It animates only opacity and scale, so it runs off the main thread; at sm (Badge, Button, StatusDot, the Switch thumb) the shutters only fade, so its footprint holds still.
- **Rule:** always shown with words.

### A-icon · Icon: FINAL

- **API:** `<Icon glyph size? label? />`. It is decorative by default (`aria-hidden`).
- **Build:** `glyphs.ts` holds the 33 inventory glyphs only. Apps may not import `lucide-preact`.

### A-art · Artwork: FINAL

- **API:** `kind: 'image'|'favicon'|'placeholder'|'disc', size: sm (`--icon-sm`) | md (`--size-art-md`) | lg (`--size-art-lg`), src?, glyph?`. Radius: `--radius-pressed` (favicon), `--radius-control` (md, lg), `--radius-full` (disc).
- **Behaviour:** the placeholder (`music`) stays under the image, which fades in. If the image fails, the placeholder stays.
- **Rule:** always decorative.

### A-tooltip · Tooltip: FINAL

- **Build:** `popover="hint"`, `role="tooltip"`, anchored, with `--inverse-surface` and `--shadow-overlay`.
- **Timing:** it shows after `TOOLTIP_DELAY_MS` of hover, or at once on focus (WCAG 1.4.13: hoverable, dismissible with Esc, persistent while hovered or focused).
- **Rules:** it can be hovered, and Esc hides it; that Esc is the tooltip's alone (nothing else acts on it, §11 call 44). It never holds anything interactive. It replaces `title=` attributes. `defaultOpen` (catalogue only) shows it from the start, so the real tooltip can be reviewed.

### A-divider · Divider: FINAL

- **What:** `--line-hair` of `--divider`, `aria-hidden`. The `inset` prop is retired.
- **Uses:** the StickyActionBar edge (only while content runs under it), between groups inside one Card, and the compact Wizard footer.

### A-heading · SectionHeader: FINAL

- **API:** `kind: 'card'|'live', level, title, meta?, actions?`.
- **Kinds:** `card` heads a Card or SettingsSection (Geist 600 at `--text-5`). `live` is "Casting now", drawn once with the gradient and a solid colour under forced colours. The `page` kind is retired: every page `h1` is a PageHeader (§9).

### A-nav · NavItem: FINAL

- **API:** `icon label href current? disabled?`.
- **Current:** `--primary-container` plus a `--line-bold` `--primary` inset edge, with `aria-current="page"` (fill, edge and weight: never colour alone).
- **States:** hover is the layer; focus-visible and a press (Enter, or a pointer, held for the morph) take `--shape-bevel`, current included; it fills its line, so nothing scales.
- **Sizes:** `--size-nav` tall; icon-only, `--size-nav` square, with a Tooltip in the narrow rail. The one container query (`app` under 45rem) hides the words and shows the Tooltip (`--tip-shown`); no script reads the layout.

### A-brand · BrandBlock: FINAL

- **What:** mark (lit while casting) plus "Thaumic Cast" in Geist 600 at `--text-6`, and in the wide rail the version line.
- **Alignment:** the mark is centred on the name's letters (the name is trimmed to its caps, F-textbox), in the header and in the wide rail. In the wide rail the mark and the name share one row of a grid and the version runs under the name, so the version never pulls the mark off the name; the version's line is kept while the version is unknown, so nothing below moves when it arrives.
- **Collapsed:** the mark alone, centred; the words stay for screen readers, visually hidden.

### A-step · StepIndicator: FINAL

- **Look:** done is filled, current is the pill, to come is a ring.
- **A11y:** `role="progressbar"` named "Step {{n}} of {{m}}: {{label}}".

### A-meter · Meter: FINAL

- **What:** a reading of a speaker's reserve in ms. Line 1 is the name (600, `--text-4-fixed` in a window) and, at the end, the value in a `--ch-ms` `.num` box. Line 2, `--space-2` below, is a full-width `--size-track` bar on `--radius-full`: `--track`, the fill `--primary`, and a `--line-bold` `--on-surface-variant` tick at the low mark, standing `--space-1` proud of the track. Low adds the `warning` glyph before the value (its `--icon-sm` slot is always reserved, so the value never moves) and draws the fill in the warning ink (two cues). A long name wraps; it is never cut off.
- **Build:** the bar is drawn by two spans and the tick (`aria-hidden`). A visually hidden native `<meter>` named "{{name}} reserve" with `aria-valuetext` carries the semantics. No meter pseudo-elements are styled, so it draws the same in every engine.
- **Where:** desktop RoomCards with diagnostics on; it works from `--track-option` (12rem). A list is a stack (`--space-4` apart); bars share the width and values end at one edge, so nothing needs a grid.
- **A11y:** named "{{name}} reserve".

### A-announcer · Announcer: FINAL

- **What:** one polite region and one assertive region per surface: `AnnouncerProvider` plus `useAnnouncer().say(message, { key?, urgent? })`.
- **Rules:**
  - Nothing is said on open.
  - `key` dedupes.
  - Messages are spaced `ANNOUNCE_GAP_MS` apart.
  - A message is emptied from its region `ANNOUNCE_HOLD_MS` after it is written, unless another replaced it, so a screen reader reading the page later never meets an old one.
  - The two regions come first in the surface, held out of the flow, so their 1 px boxes sit inside the page (§11 call 86).
  - `urgent` is used only for S2 (a danger banner after open), S6 (a room's failure) and S8 (a CastBar failure).
  - Components never render `aria-live` or `role="alert"`.

## 5. Molecules (18)

### M-field · Field: FINAL

- **API:** `label help? error? optional? id` around a TextInput. Select and Slider carry their own label (§11 call 46), and take `aria-describedby` for their help.
- **Behaviour:** the error replaces the help and comes first in `aria-describedby`. Only an optional field is marked ("Optional").

### M-setrow · SettingsRow: FINAL

- **API:** `label help? note? control controlWidth? detail? disabled? locked? error?`. `controlWidth` is `narrow` (a Switch, a Select of `--wide-control` or less), `wide` (over `--wide-control`: the SegmentedControl, a long Select) or `action` (a Button, centred against the name and the help); the row writes it as `data-width`.
- **Layouts:** compact `'label control' 'help help' 'note note'`; medium keeps help out of the control column; wide `'label control help'`, with the name and the help starting on the control's line. Wide controls stack at compact and at medium. The label track is `minmax(min-content, 1fr)`: a name never shrinks under its longest word (§11 call 41).
- **Subgrid (F-grid):** from a 25rem card, rows share their card's tracks (`grid-template-columns: subgrid`): a label track, one `auto` control track for every row, and from 45rem a help track, so controls end in one column and the help starts at one edge. The Card body is the interim settings grid (`data-settings-grid`) while it holds rows (`data-setrow` on SettingsRow and Switch); SettingsSection takes it over. A Switch row hands the tracks on to the Switch, so its track lands in the control column and its note stays in the label track (no inset computed from the Switch's width). Under 25rem each row keeps its own tracks, because one shared column as wide as the widest control would squeeze every label; on its own (outside a card) a row draws the same tracks itself.
- **`detail` slot:** shows only while the row's Switch is on. Its one use is "Start no louder than" with its Slider at 30, its value shown after the track (`readout`).
- **States:** locked by an environment variable (the control natively disabled, the row `aria-disabled`, the note text in the row with the info glyph; §11 call 39) and error. The help is `--text-2` in every row, a Switch's description included.
- **Rule:** the row never tints.

### M-choice · ChoiceGroup: FINAL

- **API:** `legend legendHidden? value onChange options[{value,label,description}] disabled?`. No size.
- **Built from Radio.** ChoiceGroup is a `<fieldset>` with a `<legend>` and a grid of Radio atoms; each option is a Radio with its `label` and `description`, unchanged. ChoiceGroup owns only the legend, the columns and the bleed (`--choice-pad`, so each ring lines up with the text above); it draws no part of an option. The option is one control: a label round one radio. It takes the layer, carries the ring and takes the bevel on focus and press (§11 call 88). The radio-card frame is retired. A multi-choice group, when one is needed, is the same fieldset round Checkbox atoms; none exists in v1.
- **Layout:** `--track-option` auto-fit columns from 25rem. No subgrid: an option is one label round one radio with its words inside it, so aligning descriptions across a row of options would need the Radio's inner text to subgrid two levels down, for a line or two of alignment (§11 call 33).
- **Uses:** Companion (Find it automatically / Enter the address), Audio quality.

### M-copy · CopyField: FINAL

- **What:** the value as text, as a DescriptionList value is (`.mono`, tabular, wraps anywhere, never cut off), plus a quiet Button sm with the `copy` glyph, named by what it copies ("Copy URL", "Copy address"). No box: the pattern of Cloudflare's Zone ID and Account ID. sm on every surface (F-size).
- **Behaviour:** `done` ("Copied", with the check) shows for `COPY_CONFIRM_MS` (2 s), then the action returns to its rest label; the Announcer says "Copied" once, politely. When the clipboard refuses, the value is selected and focused (`tabindex=-1`, an outline ring round the text), with an info note.
- **Card form** (`reveal="onRefusal"`, the RoomCard's Cast URL): the Button alone, hugging its label; the URL appears as text only on refusal.
- **Layout:** the action sits beside the value while the whole value fits, and wraps under it otherwise, at its own size; only then does the value wrap. Under 20rem of its own `field` container (a container-query literal), the action is icon-only, still named "Copy URL" / "Copy address".

### M-address · AddressField: FINAL

- **API:** `kind: 'server'|'speaker', label, value, onChange, action {idle,busy,failed}, onTest, help?, list?, onRemove?, disabled?`.
- **Width:** the server field fills its line. The speaker kind's IP field grows with its text (`field-sizing: content`) from `--ch-ip` to `--ch-ip-max`, and its box hugs it; where `field-sizing` is missing it keeps the fixed `--ch-ip` box.
- **States:** idle, testing (only the Button shows busy), success (server: StatusDot plus "Thaumic Cast answered" plus the latency in a `--ch-ms` box; speaker: the address becomes the last Chip), failed (Button "Try again", no `aria-invalid`), invalid (P-forms).
- **Contexts:**
  - Popup onboarding: server kind, compact, "Connect".
  - Options › Companion: server kind, beside, "Connect".
  - Desktop Settings › Speakers: speaker kind, "Add speaker", with the Chip list.

### M-dl · DescriptionList: FINAL

- **API:** `kind: 'readout'|'stat'|'checklist', rows`.
- **Kinds:**
  - readout: "For the next tab cast".
  - stat: Server, with tabular counts that start where the words in their column start (§11 call 35) and the Address as a CopyField.
- **Values:** a value cell may hold one trailing sm action (CopyField's Copy).
  - checklist: StatusDot plus one sentence, for the desktop Ready step and the popup onboarding's status lines. The StatusDot's own `--icon-sm` square sits on the content's edge, as the PopupHeader's status line has it (§11 call 90).
- **Build:** a real `<dl>` for readout and stat; a `<ul>` for the checklist.

### M-disclosure · Disclosure: FINAL

- **API:** `label summary? open onOpenChange size?: 'sm'|'md' disabled?`, size sm by default (32; md is the popup's list folds and a window's prominent fold). The summary's `::after` reaches `--hit-min`. Always `<details>` + `<summary>`; the `as="button"` build is retired with the desktop GroupVolume it served (the desktop is read-only; §9).
- **Look:** quiet. The chevron turns (`--dur-change`), and the summary truncates before the label; the label never truncates.
- **Fold:** `<details>` + `<summary>`, CSS only. Where `::details-content` exists, the content fades in and out, with `content-visibility` flipping at the end (`allow-discrete`). Where `interpolate-size` exists too, the content's block size also runs from 0 to `auto` and back. The fold, the fade and the chevron's turn share `--dur-change` (`--dur-effects`) and `--ease-effects`. Only its block size is clipped (`overflow: visible clip`), with a margin the size of the ring, so a focused control inside is never cut off; its sides never clip, so a flush Button inside ("Add a room") keeps the surface it reaches back with. WebKit (no `interpolate-size`) opens and shuts the height at once but still fades the content with the turn (§11 call 71); older engines, and reduced motion, open and shut at once.
- **States:** G: hover is the layer, focus-visible and press the bevel (a press held for the morph) and the 12 % layer; nothing in it moves or scales.
- **Uses:** the GroupVolume rooms fold, "Fine-tune for {{speaker}}", Advanced, "Enter the address yourself", the Rooms fold.

### M-empty · EmptyState: FINAL

- **API:** `kind: 'empty'|'searching'|'offline', title?, body, action?, link?`.
- **Look:** the idle mark, replaced by Clacks while searching. Under 25rem the art sits beside the words; from 25rem they stack and centre. The dashed border is retired.

### M-notice · Notice: FINAL

- **API:** `kind: 'banner'|'section', tone: 'danger'|'warning'|'info', lead, text?, action?, details?, onDismiss?, also?, index?`. `index` is its place in a list of notices, for the entrance stagger (T-motion). The `info` tone reads the info set (T-colour). Under 25rem, a Details that starts the action row is flush with the text.
- **Kinds:** a banner is page level, at most one, and a `role="region"` named by its lead. A section is a `<section>` named by its lead. There is no `role="alert"`. The tone is shown by the container colour, the glyph and the lead's words together (never colour alone).
- **X rule:** a blocking danger notice has no X. Esc never dismisses.
- **Layout:** the action goes under the text below 25rem and beside it from 25rem.
- **Sizes:** the action is a Button sm (32) and the X an IconButton sm (28), on every surface (F-size); the X keeps `--gap-target` from the action, so their hit areas never overlap.

### M-noticeline · NoticeLine: FINAL

- **API:** `tone: 'info'|'warning'|'danger', glyph?, lead, text?, srPrefix?, action?, details?, opensTile?, onDismiss?, index?`. The tone names match Notice (annex 2's `neutral` is `info`).
- **One item per row, five uses:**
  - row line (danger, Try again, X)
  - tile note (info, Details, X)
  - CastBar line (danger, X)
  - slot line (opens the tile, no X)
  - away line (info, the `history` glyph, "{{count}} more", X)
- **Sizes:** the action is a Button sm (32; the round 12 popup drawings show 28, superseded) and the X an IconButton sm (28), kept `--gap-target` apart.
- **Rule:** words wrap and never truncate. Leads are 34 characters or fewer (F-voice). A short lead (about 20 characters at 13 px) fits one popup row with its action or "{{count}} more" and the X; a longer one, or any lead at larger text, wraps whole, filling its first line (plain wrapping; 1.4.4, 1.4.10; §11 call 43).

### M-toast · Toast: FINAL

- **API:** `text action? onDismiss`, where `action` is `{ label, onClick? | onAction?, labels? }` as on Notice and NoticeLine, so Undo can be busy and fail (§11 call 44). The text wraps and is never cut off.
- **Look:** inverse surface, the info glyph, a quiet action, X. It has no tones.
- **Rules:**
  - It lives in flow: in a StickyActionBar (the popup and the options page) or in the desktop's toast row. Never in the top layer, so it takes no shadow.
  - One at a time, never on a timer. It goes on the next action, Esc, X or leaving. An Esc that something open takes first (a tooltip, a dialog, a popover, an open select) is not the Toast's.
  - Undo follows a removal only: a room from a cast (popup), or a set (options › Sets). Never after Stop (P-stop).
- **Sizes:** the action is a Button sm and the X an IconButton sm, kept `--gap-target` apart (F-size).
- **A11y:** the Announcer says it, and it never takes focus.

### M-roomrow · RoomRow: FINAL

One row per room. It absorbs SpeakerRow, SpeakerVolumeRow, SpeakerMultiSelect's rows, CheckRow and the speaker list items.

- **`pick`:** the `<label>` is the checkbox. The sub line holds "Grouped with …", a Badge and "at 72 now". StartLevel sits outside the label. The row is unavailable when the room does not answer.
- **`cast`:** name plus Badge; mute, Slider, value (`--ch-volume`) and Remove. "Joining…" makes the row inert. A failure adds a row line with Try again. The last room has no Remove (Stop ends the cast). The volume line's columns are fixed tracks, the same on every row: mute and the Remove slot are an IconButton wide (`--control-sm`) and the Slider takes the rest, so every row of a cast (joined, joining, failed, muted, the last room without Remove) has its Slider start and end at one place; the slot is kept empty when there is no Remove, and the GroupVolume master keeps it too (§11 calls 90, 91).
- **`list`:** read-only, with a disc Artwork, the name, a sub line and a Badge.

### M-startlevel · StartLevel: FINAL

- **What:** LevelButton (the number and a chevron, `aria-expanded`) opens StartLine: a Slider with a ghost tick at the current level, a `--ch-volume` value and a caption.
- **Text forms:** "…" while the level is unknown (on the LevelButton for a chosen room while the limit is on, §11 call 83); "Fixed" for a fixed output, as text.
- **Rule:** the level is pending, and nothing is sent before Cast.

### M-media · MediaHeader: FINAL

- **API:** `kind: 'tab'|'browser', art?, title, subtitle, playing, size, disclosure?, transport?, onGoToTab?, trailing?`.
- **Kinds:** `browser` reads "Whole browser" / "Browser-wide capture" with a monitor disc, and has no transport.
- **Go to tab** shows only when the popup is open over another tab; on the cast's own tab it would go nowhere (§11 call 88).
- **Open tile:** it sits on the artwork band, which bleeds to the card's top and sides (`bleed`: the card's inner corner, and the tile's `--space-1` inset added to the band's padding, so nothing on it moves; §11 call 88); the red guard moves Stop off the band.
- **Desktop:** read-only.

### M-groupvol · GroupVolume: FINAL

- **One room:** its volume line plus "Add a room".
- **Two or more rooms:** a master (the Sonos group volume, showing the mean) plus the "{{count}} rooms" fold, whose summary lists the levels. Then the rows, then "Add a room" last, which opens the add list. The master keeps the rows' empty Remove slot, so the card has one volume column: its Slider starts and ends where the rows' do (§11 call 91). The compact tile's line has no slot.
- **Nothing to add:** "Add a room" shows only while some room is neither in the cast nor joining it; with none it is gone, and an open add mode shuts (§11 call 88).
- **Memory:** open or shut is remembered for the popup session.

### M-videosync · VideoSync: FINAL

- **What:** the row for one cast's video sync, in the open CastTile. From the top: a Divider,
  then a Switch ("Video sync", with the phase's Badge inside the one name). When there is a
  reason, it is the Switch's description. Under that sit the action, if any, as a flush quiet
  Button sm, and then, while the trim applies, the "Fine-tune for {{speaker}}" Disclosure (the
  trim Slider). There is nothing else: no resync, no lead or source readout.
- **API:**
  `on, phase?, reason?, action?, trim, onToggle, onTrim, fineTuneOpen?, onFineTuneChange?, strings`.
  `phase` is protocol's `VideoSyncPhase` (`import type` from `@thaumic-cast/protocol`, already a
  peer dependency of `packages/ui`). It is `undefined` until the background answers, or when the
  background says the cast has no video sync running. `reason` is the reason's words, chosen by
  the app. `action` is `{ label, onPress }`, also chosen by the app: Reload page when the phase is
  `unavailable` and the reason is `reload`, else Try again when the phase is `turned-off`, else
  none.
  `strings` holds `label`, `phases` (one word per phase except `off`), `fineTune` (with the
  speaker filled in), `ms` (the readout and fold summary, for example "+120 ms") and `trimWords`
  (`aria-valuetext`: "No adjustment", "Sound 120 ms earlier", "Sound 120 ms later").
- **Badge tones** (never colour alone: busy shows the Clacks, warning shows its glyph, and every
  phase has its own word): locking is busy; in-step and no-video are neutral; unavailable and
  turned-off are warning. Off has no Badge, because the thumb's position says it. An unknown
  phase has no Badge either.
- **Reason line:** shown only when the Switch is on, the phase is `unavailable` or `turned-off`,
  and a reason exists. It is the Switch's `description` (help size, `--text-2`), so it is read
  with the Switch (`aria-describedby`), never inside its name. It wraps and is never cut off.
- **Action:** a quiet Button sm, `flush`, under the reason, starting at its text edge: "Reload
  page" or "Try again". It has no busy, done or failed state, because its result is the next
  phase. If the Button is focused when it goes away (the phase moved on), focus moves to the
  Switch, never to `<body>` (2.4.3).
- **Fine-tune:** shown while the Switch is on and the phase is known and is neither `off` nor
  `unavailable`. That covers locking, in step, nothing to watch and turned off: a trim still
  matters for the next try. It is a Disclosure sm, shut by default and never opened on its own.
  Open or shut is remembered for the popup session, as GroupVolume's rooms fold is. The label is
  "Fine-tune for {{speaker}}" (the followed speaker, the cast's first room) and the summary is
  the trim (`ms`). Inside sits one Slider with the same name, −500 to +500 ms in steps of 10,
  `centre` 0, `readout` 7 (`--ch-ms`), `format` = `ms` and `valueText` = `trimWords`. The trim is
  per speaker, and the hook debounces and keeps it.
- **Toggle:** a per-cast Switch, always enabled (it is how you leave a "Cannot sync" state). On
  means locking at once (optimistic); off means off at once, and the Badge, reason, action and
  Fine-tune go together.
- **Announcements** (A-announcer, polite): when the phase or reason changes after the first
  known phase, VideoSync says "{{label}}. {{phase word}}." (no full stop after a word that
  ends in "…") and adds the reason sentence when one is drawn. It says nothing on open (the first status after mount is drawn, not said), nothing
  for `off` (the Switch speaks for itself), and nothing from a compact tile (VideoSync is not
  drawn there). With several open tiles the line does not name the cast; naming it would need a
  new string.
- **States:** the Switch, Button, Disclosure and Slider keep their own (G). VideoSync adds none.

### M-wizardstep · WizardStep: FINAL

- **What:** a disc Artwork plus the step's `h2` plus a subtitle plus a body slot.
- **Gap:** the `h2` is trimmed (F-textbox), so the subtitle sits `--space-3` under it, as BrandBlock and PageHeader give their trimmed titles room.
- **Disc:** it starts with the title, not centred on the header, so a title that wraps (the welcome's, in the popup's Card) keeps its first line beside the disc (§11 call 91).
- **Focus:** moves to the `h2` on a step change.
- **Popup:** the parts sit `--space-4` apart (the Card's gap; `--space-5` on the desktop), and the body is set in the popup's `--text-3` (`--text-4` on the desktop): its paragraphs are plain `<p>`s with no type of their own. `note` is a quieter last line (`--text-2`, `--on-surface-variant`), for "\* Over your own network…" (§11 call 90).

### M-pageheader · PageHeader: FINAL

- **What:** an `h1` at `--text-8` plus an optional summary ("4 rooms, 2 casting") plus optional actions in a Cluster. It is every page title: the desktop views, Not found and the options page ("Settings", no summary, no actions).

## 6. Components (15)

| Id            | Component              | Built from                                                                                                                                        | Key rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-popupheader | **PopupHeader**        | BrandBlock, StatusDot plus words, Settings IconButton (`mark`)                                                                                    | It scrolls away. It takes the content's inline edges, with no inline padding of its own: the mark starts where the section headings and cards start, and Settings ends where the cards end, so header and main are one column. It never shows a count. States: connected (desktop app or server), casting (lit mark), checking, reconnecting ("Asking the companion again…"), not connected. A status change is said once. While an update exists, Settings is marked, named "Settings, update available" with its Tooltip, and opens Settings at About.                                                                                                                                                                                  |
| C-picker      | **RoomPicker**         | fieldset "Cast to", set Buttons (`pressed`, `trail`: every set's room count), Divider, RoomRow `pick`, Disclosure, TextInput `search`, EmptyState | Sets are Last cast, saved sets, and "Everywhere" from 3 rooms; Last cast is left out when a saved set or Everywhere holds exactly its rooms. One set at most is `pressed`: Everywhere when every room is chosen, else the first saved set of exactly the chosen rooms, else Last cast. The rooms fold from 8 rooms, and search lives inside the fold; it never unticks a room and it counts hidden chosen rooms in one line of text under the list. "Save these rooms as a set" opens an inline form. When not connected, the fieldset is disabled. The save offer opens in place, as the CastBar's line does (§11 call 91).                                                                                                              |
| C-castbar     | **CastBar**            | filled Button, the polite line, NoticeLine on failure                                                                                             | "Cast to {{count}} rooms". The line says at most the leaves sentence, the restarts sentence, then the replace hint, left out beside the restarts sentence (with an older companion, the "plays too" sentence and the hint). Add mode says the same for the rooms being added. Add mode is Cancel plus "Add {{count}} rooms". The line sits above Cast (or Add) in every state, before it in the reading order, and opens in place: its block size runs from 0 with the gap above Cast, and its words fade in from `--space-2` below (§11 call 90, replacing call 89's rule). It is a clipping flex item, so it sets `min-block-size: 0`; without it the automatic minimum held it at its words' height and it snapped open (§11 call 91). |
| C-tabcard     | **TabCard**            | Card, MediaHeader (`tab` or `browser`), RoomPicker                                                                                                | Shown only while this tab is not casting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| C-casttile    | **CastTile**           | Card, MediaHeader, Stop Button, GroupVolume, NoticeSlot, VideoSync                                                                                | Compact or open in place. The head row is the same element in both forms, at one spot: wherever no band is drawn (compact, or open on a cast with no artwork) it keeps the band's place. This tab's cast is open. A single cast has no chevron. VideoSync is drawn only on an open tile, and only for a cast that started with video sync on (`cast.videoSync`). It comes last, after the tile notes. A compact tile shows no video sync: not in the slot, not in the head row, and it is not said.                                                                                                                                                                                                                                       |
| C-noticeslot  | **NoticeSlot**         | Notice (section), NoticeLine                                                                                                                      | The first item is drawn in full and the rest are lines. On a compact tile it is one slot line. Order: may cut out soon, cut out, capture health, gaps, drift (≤ 10 min). No quiet-tier lines.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| C-setlist     | **SetList**            | rows (name, "{{count}} rooms", Rename and Remove as quiet Buttons), inline TextInput, EmptyState, Toast                                           | Rename in place; an empty name is an error; Escape is Cancel. A long name wraps, never cut off, and Rename and Remove stay beside it. Remove takes effect at once and the Toast offers Undo. Last cast and Everywhere are not listed. Built in Settings › Saved sets (§11 call 88).                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| C-section     | **SettingsSection**    | Card, SectionHeader, SettingsRows on one subgrid, Dividers                                                                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| C-card        | **Card**               |                                                                                                                                                   | One look: `--radius-card`, `--surface`, a `--line-hair` `--card-edge` (`--outline-variant` in light only). No raised kind; `interactive` is not built until needed. `flush` drops the padding and clips nothing (a clip would cut a child's focus ring); a part that paints to the edge rounds its own corners. Padding `--space-4` (`--space-5` on the desktop); in the popup its inline padding is the flush cards' head inset (`--space-1` plus `--space-3`, where the TabCard's and CastTile's MediaHeader start), so every card in the popup has one text edge (§11 call 90).                                                                                                                                                        |
| C-dialog      | **Dialog**             | `<dialog>`, IconButton Close, Cluster `stack`                                                                                                     | One kind: the modal confirm, for Stop all casts and Disconnect extensions (the sheet kind is retired; nothing uses it). `--radius-dialog`, `--surface`, `--shadow-overlay`, `--scrim`. Initial focus is on Cancel; Esc and Close cancel; focus returns to the opener. Actions stack under 25rem.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| C-roomcard    | **RoomCard** (desktop) | Card, name, Badge, sub line, MediaHeader (read-only), CopyField "Cast URL", Meter                                                                 | Read-only: no Stop and no volume. Copy URL is a Button sm hugging its label; the URL is revealed as text when the clipboard refuses. Sizes come from F-size. Cards sort casting first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| C-rail        | **Rail**               | BrandBlock, NavItems                                                                                                                              | `--rail-narrow` below a 45rem window, `--rail-wide` from it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| C-wizard      | **Wizard**             | WizardStep, StepIndicator, Back IconButton, Skip, Carry on                                                                                        | Compact form in the popup (L-wizard: PopupShell `fill`, the step in a Card); full form on the desktop (Back as an outline Button).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| C-badge-tb    | **ToolbarBadge**       | T-chrome                                                                                                                                          | Shows "!" with the title "Thaumic Cast: {{lead}}", never a count. Nearly cut out and drift over 10 min never set it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| C-tray        | **TrayMenu** (native)  |                                                                                                                                                   | Order: version (disabled), status (disabled), —, Open Thaumic Cast, —, Launch at login (check item), —, Stop all casts (disabled while idle; no confirm), Restart Thaumic Cast, —, Quit. Idle and lit icon. Tooltip "Thaumic Cast" and the stop-all variants.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

The API of each popup component is in annex 2 §11–16. SetList, RoomCard and TrayMenu are in annex 3.

## 7. Patterns (13)

| Id          | Pattern                | The rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P-notices   | Notices at the source  | Placement, suppression ("a bigger problem hides what it explains"), order, dedupe and auto-clear. Toasts are never timed. Screen readers hear nothing on open. The quiet tier is removed: `head_start_close` and drift over 10 min show **nowhere** in the popup; on the desktop they appear only through the Meter with diagnostics on. Replacement text for the round 11 notices spec §2.3, §4, §6 and §11 is in annex 2.                                                                                                                      |
| P-companion | An old companion warns | A warning banner, dismissible per build: "This companion is older than the extension" / "It is on v{{appVersion}}, and it may still work. If anything misbehaves, update it." plus Update. **Cast stays enabled.** "Update available" is the mark on the popup's Settings, which opens About (options), where its link is. It ranks last for the banner.                                                                                                                                                                                         |
| P-away      | While you were away    | One neutral NoticeLine with the `history` glyph, first after the header and the banner, once per open. It shows the newest lead; "{{count}} more" (or "Details" for one event) opens the list in place; X dismisses it. Its spoken name is "While you were away: {{lead}}". Storage: `chrome.storage.session`, the last 10 events, none older than 24 h, each shown once.                                                                                                                                                                        |
| P-start     | Start level            | start = min(the room now, the limit). The limit, "Start no louder than", is on at 30. Nothing is remembered. A level set by hand wins for this cast only, with no warning. "…" while unknown (if it still cannot be read at Cast, the room starts at the limit). "Fixed" for a fixed output. The row-text table in annex 2 §4 supersedes `r12/start-level.md`.                                                                                                                                                                                   |
| P-picker    | Picker model B         | Sets, then rooms. The rooms fold from 8. Search only inside the fold. Sets live on this device and are never synced. On open the choice is Last cast's rooms that no other cast holds; with none, the first free room alone in its group and playing nothing. A room another cast holds is never chosen for the user.                                                                                                                                                                                                                            |
| P-addroom   | Add a room             | "Add a room" opens the add list; CastBar add mode commits. The room joins the cast's Sonos group at min(now, limit). The row says "Joining…"; on failure, a row line offers Try again.                                                                                                                                                                                                                                                                                                                                                           |
| P-stop      | Stop, Remove, Undo     | Stop is tonal danger plus the square plus "Stop", named "Stop casting {{title}}". Stop all casts is filled danger plus a confirm. Remove is a quiet IconButton with the square. **No Undo after Stop**: the Announcer says "Cast to {{name}} stopped." and focus moves to the next tile's Stop, or to the TabCard's heading. Undo after removing a room stays (and after removing a set in Settings). "Cast again" is not in v1. Stop all casts confirms in the desktop app (a Dialog) and not in the tray (a native menu cannot host one; §12). |
| P-x         | The X rule             | X appears only when dismissing has no consequence and the fact lives on elsewhere.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| P-fold      | Fold in place          | Long content folds in place. Nothing in the popup sets its own scroller.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| P-states    | Empty, loading, error  | EmptyState, Clacks with words, "Loading settings…", "The settings were not saved. Try again.", "Speakers are listed here once the companion answers." Loading text is plain text in the slot with `aria-busy` on its container, never a live region. The popup paints nothing until its stored state is read (one storage read, no spinner), then the PopupHeader in `checking` and RoomPicker `loading`.                                                                                                                                        |
| P-copy      | Copy feedback          | The write starts inside the click. `done` ("Copied") shows for `COPY_CONFIRM_MS` (2 s), then the action returns to rest: it is a transient echo of the user's own action, not a message to read, so the no-timers rule (which stays for anything people need time to read) does not cover it. The Announcer says "Copied" once, politely. A refusal reveals and selects the value, with its note and no timer.                                                                                                                                   |
| P-forms     | Form validation        | An error shows on blur or submit and clears as soon as the value is valid. On submit, focus goes to the first invalid field. The error is a `--line-bold` `--danger-ink` edge plus the `danger` glyph plus the message, with `aria-invalid`, and is not a live region. A failed request is not a validation error.                                                                                                                                                                                                                               |
| P-diag      | Diagnostics            | A desktop setting, "Show diagnostics", off by default. It needs speaker monitoring and shows the reserve Meter on RoomCards.                                                                                                                                                                                                                                                                                                                                                                                                                     |

The Sonos group model (one group per cast, guarded restore) is product behaviour, not design-system behaviour. It lives in the round 12 Sonos groups note, and its five hardware tests must run before it ships.

## 8. Layouts and shells (5)

| Id        | Shell               | Structure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L-popup   | **PopupShell**      | The document is the one scroller: `inline-size: var(--popup-inline)`, `max-block-size: var(--popup-block-max)`, the page scroller's gutter on both edges (F-shift), padding and gap `--space-4`. The order is PopupHeader › banner (0–1) › away line (0–1) › content › StickyActionBar. There is no footer, no end row ("Update available" is the mark on Settings, C-popupheader) and no version line (the version is in Settings › About). Scroll padding is `calc(var(--overlay-end) + var(--space-3))` (WCAG 2.4.11, checked on every frame). `fill` makes it as tall as the popup can be (`--popup-block-max`) whatever the content, the content filling it and the bar at its end: the compact Wizard. It replaces the round 7 CSS notes §5 and §9.                                                                                                                                                                   |
| L-bar     | **StickyActionBar** | `position: sticky; inset-block-end: 0; z-index: var(--z-sticky)` on `--surface`, padding `--space-3` block. The `--line-hair` `--divider` hairline shows only while content runs under it (a scroll-state query, Chromium 133); where scroll-state queries are missing (the Chrome 125 floor, all WebKit) it is always shown. Built in Phase 3. It publishes its block size as `--overlay-end`, and its scroller sets `scroll-padding-block-end: calc(var(--overlay-end) + var(--space-3))`. Two homes: the popup (the Toast, then the CastBar or the Wizard's Skip and Carry on) and the options page (the Toast only; 0 tall while there is none). Holding only a Toast, it draws no surface: the Toast sits on the ground, and the PopupShell's gutter strip follows it.                                                                                                                                                 |
| L-page    | **OptionsShell**    | One column, `max-inline-size: var(--page-max)`, `data-density="desktop"`, PageHeader "Settings". SettingsSections sit `--space-5` apart. No status header and no footer. A StickyActionBar at the end holds the Toast, so a focused control is never under it (2.4.11). Every control saves on change. The Language section is hidden while there is one language (as on the desktop).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| L-desktop | **DesktopShell**    | Rail plus main (container `content`, the one scroller) plus PageHeader. The toast row sits under main, outside the scroller, and is 0 tall until a toast opens it, so it never covers focus. Window 840 × 640 by default (a Tauri setting, not CSS). Views: Speakers (RoomCards), Server (DescriptionList `stat` + SettingsRows with Button controls), Settings (SettingsSections), Not found (EmptyState "There is no page here" + Button `href` "Back to Speakers").                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| L-wizard  | **WizardShell**     | Compact: the main popup's frame, a PopupShell `fill` (as tall as the popup can be on every step, so the popup never changes size; §11 call 88). Its header is a row as tall as the PopupHeader (its min-block-size and block padding): Back (tonal IconButton, as the PopupHeader's Settings, from step 2) on the content's start edge, the StepIndicator centred, and a slot as wide as Back opposite it, kept on step 1 so nothing moves. The step sits in a Card on the main popup's card edges, starting where the main popup's first card does; its parts take the cards' content edge and the popup's type. Skip (flush quiet, pulled back only to the step's text edge, so its words start where the step's text does and its ring stays clear of the popup's edge) and Carry on sit in the StickyActionBar, with the Cast bar's surface, padding and edges (§11 calls 90, 91). Full: DesktopShell without the Rail. |

## 9. Retired (do not build)

Each retired item and what takes its place:

- **ActionButton** → Button `onAction`.
- **SetButton** → Button `pressed`.
- **Toggle** → IconButton `pressed`; the cast kind is gone entirely.
- **ToggleSwitch** → Switch.
- **FindField** → TextInput `search` inside RoomPicker.
- **Number input** → Select (head start), or TextInput `address`.
- **CheckRow** → RoomRow `pick`.
- **StatusChip, SyncStatus, StatusMark, the DeviceCard pill** → Badge.
- **LiveLamp** → StatusDot `live`.
- **TransportIcon** → Badge words.
- **ButtonGroup, ChipSet** → Cluster.
- **SpeakerRow, SpeakerVolumeRow** → RoomRow, StartLevel.
- **SpeakerMultiSelect, SpeakerPicker** → RoomPicker.
- **NoticeGroup, NoticeStack, ConnectionBanner** → Notice banner and NoticeSlot.
- **The R8 CastCard** → CastTile.
- **The R8 / R7 popup shell** (header / notices / content / footer rows, the toast over the footer) → PopupShell.
- **Retired kinds, states and sizes:**
  - Chip filter and choice kinds
  - Card `raised`
  - Notice `summary`, `collapsed` and `collapsible`, with "Show the whole notice" and "Show less"
  - Badge `remote`, `np` and `new`
  - StatusDot `off`
  - the Divider `inset` prop
  - IconButton filled, and the 20 px sm size
  - Button tones neutral and primary, and sizes lg and xl
  - Toast tones and the 4 s / 6 s timers
  - the radio-card frame
  - the two copy-label timers (one `COPY_CONFIRM_MS` echo replaces them; §11 call 26)
  - the dashed empty-state border
  - **v1 audit (unused or duplicated):** Checkbox `indeterminate`; Badge `count` tone; TextInput `busy`; SectionHeader `page` kind (PageHeader is every page title); Disclosure `as="button"`; Dialog `sheet` kind; NoticeLine tone name `neutral` (it is `info`)
- **Tokens:** radius 20 and 36, 18 px icons, the two-step card shadow, the four `@keyframes spin` copies, the notice-area layout-shift row, today's `--touch-target-size: 48px`, font weight 500, and every off-step spacing value (the snap list, T-space).
- **Behaviour and screens:**
  - the quiet tier ("Nearly cut out"; "Clock runs fast" while more than 10 min away)
  - Undo after Stop
  - "Cast again"
  - the header notice count
  - the desktop "Recent" page
  - the row "More for {{name}}" menu
  - the "Play speakers as one group" setting (retired in the build by call 84)
  - the popup's end row ("Update available" is the mark on Settings, call 84)
  - the word "Saved" on a saved set (every set shows its room count, call 84)
  - picker models A and C
  - the "All" slider
  - one row per Sonos group
  - the start sentence in the bar
  - the warning on a start level raised by hand
  - the popup's version line (the round 12 drawings still show "Version 0.12.0" at the foot; the version lives in Settings › About)
  - the options page's sticky toast row as a separate thing (it is a StickyActionBar)
  - the options page's Language row while there is one language, and its hint "English only, so far." (`language_coming_soon`)
- **Strings:** `unmute_speaker`, `sync_speakers_enable`, `sync_speakers_description`, `saved_set`, `version_mismatch_message`, `version_mismatch_unknown_message`, `cast_to_n_speakers_*`, `video_sync_toggle`, `video_sync_status_waiting`, `video_sync_status_lost`, `video_sync_resync`, `error_speaker_stop_failed` (in the popup), `onboarding.speakers.found_*` (popup), `settings.remove_speaker`, `device.coordinator`, `device.others_*`, `transport.playing`, `speakers.summary_speakers_*`, `onboarding.ready.summary_speakers_*`. The full retired lists are in the annexes.

## 10. Only the design system: the rules and how they are enforced

### Apps may use

1. Tokens through `var(--…)`, for every colour, space, size, line, radius, shadow, font, weight, duration, ease and z value, alone or inside `calc()`.
2. Foundations by name: `.num`, `.mono`, `.visually-hidden`, `Cluster`, and the shared keyframes (`animation-name` only). Responsive layout lives in the shells and components; apps write no `@container` or `@media` rules.
3. Design-system components, imported from `@thaumic-cast/ui` only.
4. Literals that are not design values: `0`, `100%`, `auto`, `1fr`, `min-content`, `max-content`, `currentColor`, `transparent`, `inherit`, `none`, and `100dvb` (the desktop shell as tall as the window, L-desktop; §11 call 47). Type (size, weight, family, line height, tracking) and z come from tokens only.

### Apps may not use (`apps/*/src`)

- Raw colours: hex, `rgb()`, `hsl()`, `oklch()`, `color-mix()` or named colours. Relative colour is allowed only inside `packages/ui`.
- Any length, time or angle unit (`px`, `rem`, `em`, `ch`, `ms`, `s`, `deg`): lengths and times come from tokens.
- Physical properties.
- `z-index` other than the two tokens.
- `!important`.
- `@keyframes`, `@container`, `@media`.
- Inline `style=`, except to carry a custom property.
- Raw `<button>`, `<input>`, `<select>`, `<textarea>`, `<dialog>`, `role="alert"` or `aria-live`.
- `lucide-preact` (use `Icon`).
- Deep imports of `packages/ui/src/*` or its CSS modules.
- One-off components that draw a control or a container. An app component only arranges design-system components and supplies data and strings. A new look goes into `packages/ui` first.

Inside `packages/ui`, components follow the same rules, except that they may define `--{component}-*` tokens mapped to T-tokens, write container queries on the named containers, and use relative colour. `tokens.css`, `webkit-fallbacks.css` and `base.css` are the only files that hold raw values, with two files whose literals this spec writes out: `utilities.css` (F-utils: the 1px `.visually-hidden` box and the `ch` box of `.num`) and `fonts.css` (the `@font-face` descriptors of F-shift).

### Enforcement (lean: built-in rules, one script, one catalogue)

No new lint plugin is needed. `stylelint.config.js` already has `stylelint-use-logical`, `color-no-hex`, `color-named` and `function-disallowed-list`; v1 adds built-in rules through `overrides`, and eslint uses two built-in rules.

| #   | Check                                               | Tool and rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Scope                                                                            |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | Values come from tokens                             | stylelint `declaration-property-value-allowed-list` (built-in): the value properties may hold only `var(--…)`, `calc()` over `var()`, and the "may use" literals                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `apps/**/*.css`, and `packages/ui/src/**/*.css` except the three raw-value files |
| 2   | No raw colour, no units, no local motion or queries | `function-disallowed-list` adds `oklch` and `color-mix`; `unit-disallowed-list: [px, rem, em, ch, ms, s, deg]`; `at-rule-disallowed-list: [keyframes, container, media]`; `declaration-no-important`; `property-disallowed-list: [transition, animation]` (longhands only)                                                                                                                                                                                                                                                                                                                                                                            | `apps/**/*.css`                                                                  |
| 3   | Logical properties                                  | `csstools/use-logical` (in place)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | all CSS                                                                          |
| 4   | Imports and raw controls                            | eslint `no-restricted-imports` (`@thaumic-cast/ui/src/*`, `lucide-preact`) and `no-restricted-syntax` (lower-case `button`, `input`, `select`, `textarea`, `dialog` elements; `role="alert"`; `aria-live`; a `style` object with a key that is not `--*`)                                                                                                                                                                                                                                                                                                                                                                                             | `apps/**/*.tsx`                                                                  |
| 5   | The token graph and the floors                      | `scripts/check-ds.ts`, run by `bun run lint:ds` (by `bun run lint` from Phase 5): every `var(--x)` is defined in `tokens.css` or a component block; every `--{component}-*` maps to a T-token; tokens defined and never used are listed; `glyphs.ts` holds exactly the F-icons list; every `packages/ui` CSS module is one `@layer components` block; `light-dark(` appears only in the generated token files; no component reads a status set by name (`--{set}-*`, `--on-{set}-container`: it sets `data-tone` and reads `--tone-*`); every feature above the floors (below) sits inside an `@supports` that tests for it                           | repo                                                                             |
| 6   | Every item, every state                             | `packages/ui/catalogue/` (a Vite page, no Storybook) renders every item in every kind and the states in §3's matrix, light and dark, both densities; Playwright takes its screenshots (baselines made in the CI Linux image only) and `@axe-core/playwright` checks it in the same run, in Chromium and in WebKit (the catalogue loads `webkit-fallbacks.css`, as the desktop does, and its floor mode `?floor=1` takes away what the desktop's WebKit floor lacks, so the fallbacks render; §11 call 52); container-query items are framed at compact, medium and wide in both densities, with the narrow rail, the fluid ramp and a resizable frame | `packages/ui` changes, CI                                                        |
| 7   | What lint cannot see                                | review: an app component draws no control and no container; a new look goes into `packages/ui` first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | PRs touching `apps/**`                                                           |

Rows 1 and 2, as they go into `stylelint.config.js`:

```js
overrides: [{
  files: ['apps/**/*.css'],
  rules: {
    'declaration-property-value-allowed-list': {
      '/^(color|background(-color)?|border(-.+)?-color|outline-color|fill|stroke|box-shadow|text-decoration-color)$/':
        ['/^(var\\(--[\\w-]+\\)|currentColor|transparent|inherit|none)$/'],
      '/^(font-(size|weight|family)|line-height|letter-spacing|z-index)$/': ['/^var\\(--[\\w-]+\\)$/'],
      '/^(gap|row-gap|column-gap|padding.*|margin.*|inset.*|border(-.+)?-(width|radius)|border-radius|outline-(width|offset)|(min-|max-)?(inline|block)-size|(transition|animation)-(duration|delay|timing-function))$/':
        ['/^((var\\(--[\\w-]+\\)|calc\\([^;]*\\)|0|100%|auto|1fr|min-content|max-content|none|inherit|100dvb)\\s*)+$/'],
    },
    'function-disallowed-list': ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklch', 'color', 'color-mix'],
    'unit-disallowed-list': ['px', 'rem', 'em', 'ch', 'ms', 's', 'deg'],
    'at-rule-disallowed-list': ['keyframes', 'container', 'media'],
    'declaration-no-important': true,
    'property-disallowed-list': ['transition', 'animation'],  // longhands only, so every time and ease is a token
  },
}],
```

`calc()` passes row 1 but its literals still meet row 2's unit ban, so `calc(var(--space-3) + 2px)` fails.

### The floors

The extension's floor is **Chrome 125** (`minimum_chrome_version` in its manifest, `cssTarget: 'chrome125'` in its build). The desktop's floor is the system WebKit on **macOS 13 with Safari 16.4** (`minimumSystemVersion: "13.0"` in `tauri.conf.json`; every macOS 13 update path reaches 16.4) and **WebKitGTK 2.44** (about Safari 17.4); WebView2 is evergreen. At 16.4 the system can rely on `color-mix()`, `@property`, `lh`, subgrid, `:has()` and container queries, so it writes no fallback for them.

What the floors lack, and the fallback each one ships:

| Feature                                 | Missing at                            | Fallback                                                                             |
| --------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------ |
| `light-dark()`                          | Safari before 17.5, GTK 2.44          | `webkit-fallbacks.css`, generated, loaded by the desktop (and the catalogue)         |
| relative colour                         | WebKit before 18                      | the sRGB stops (live gradient); JS `--art-*` (seeded card)                           |
| `corner-shape`                          | Chrome 125 to 138, the WebKit floors  | no shape change at all: colour and the ring carry hover, focus and press (F-grammar) |
| `text-box`                              | Chrome 125 to 132, WebKit before 18.2 | today's padding; `min-block-size` keeps the size                                     |
| `sibling-index()`                       | Chrome 125 to 137, WebKit before 26.2 | the inline `--i` from Preact                                                         |
| `@starting-style`                       | Safari before 17.5, GTK 2.44          | the item appears without an entrance                                                 |
| `::details-content`, `interpolate-size` | Chrome 125 to 130, WebKit before 18.4 | the Disclosure opens and shuts at once                                               |
| `field-sizing`                          | WebKit before 26.2                    | the fixed `--ch-ip` box                                                              |
| `appearance: base-select`, `:open`      | Chrome 125 to 134, the WebKit floors  | the native `<select>` and the OS list                                                |
| anchor positioning, `popover="hint"`    | the WebKit floor                      | the Tooltip's JS placer, `hidden` toggled by JS                                      |
| scroll-state queries                    | Chrome 125 to 132, all WebKit         | the bar hairline is always shown (Phase 3)                                           |
| `scrollbar-gutter`                      | the WebKit floor                      | none needed: overlay scrollbars take no room                                         |

Each of these sits inside an `@supports` that tests for it, which `check-ds.ts` enforces for relative colour, `sibling-index()`, `corner-shape`, `text-box`, `field-sizing`, `::details-content`, base-select and `:open`: a declaration that holds `var()` is not dropped when an engine lacks the feature, it goes invalid when it computes. CSS nesting is not written in `packages/ui` (Safari 16.4 lacks it, and nothing lowers it for the desktop).

**New dependencies:** two dev dependencies, `@playwright/test` and `@axe-core/playwright`, for row 6 only. They are the one place where every state is rendered and checked, which the owner's "only from the design system" needs proven, not promised.

**Adoption:**

1. Phase 0 adds rows 1 to 5 as a report, `bun run lint:ds`, which prints every violation and exits 0. They are kept out of `bun run lint` because the project rule is that warnings are fixed before committing, and today's apps break these rules in hundreds of places that later phases rebuild. `packages/ui`'s own new files already pass them. Row 6 lands with the foundations' catalogue section and grows with each phase.
2. Phases 1 to 4 fix the offenders as each part is rebuilt: 20 raw colours, 78 literal font sizes, 22 literal weights, 56 literal gaps, 25 px sizes, 11 literal transitions, 6 inline styles, 19 dead classes, `--font-size-sm`, 13 raw selects, 11 raw checkbox and radio inputs, the raw url and range inputs, and 2 raw buttons.
3. Phase 5 moves every rule into `bun run lint` as an error, so a violation is never left to pile up.

## 11. Consolidation calls

Where the packets disagreed with canon or with each other, these are the calls made here. All are reversible.

1. **Toast has no shadow, anywhere.** All three Toast homes are in flow. `--shadow-overlay` goes to Dialog, Tooltip and the Select listbox. This supersedes canon T-elev ("Toast"), and the "top-layer toast (desktop)" note in annex 2 §10.
2. **Toast has no live role.** The Announcer says it. Annex 3's `role=status` on the SetList Toast is superseded.
3. **The square means sound stops.** Remove for a room in a cast is a quiet IconButton with the square. SetList's Remove deletes a set, so it is a quiet Button with the word and no glyph. This confirms annex 3 and amends canon A-button.
4. **Button gains `expanded` and `description`**, instead of local parts (annex 2, unresolved 3). No app needs a one-off control for "Add a room" or for a set that does not answer.
5. **"A set needs a name."** (annex 3) replaces annex 1's longer draft.
6. **The server action is "Connect"** (shipped), not canon's working name "Test". No string is added.
7. **The Stop button's name is "Stop casting {{title}}"** (`stop_cast_named`). The rooms are already in the subtitle beside it.
8. **The away line's visible words are the lead alone.** The `history` glyph stands for "while you were away", and the full sentence is the spoken name. The sentence does not fit one line at 325 px.
9. **The 15rem wide-control threshold** becomes an F-grid constant.
10. **Tray "Stop all casts" is disabled while idle.** This is a one-line `tray.rs` change.
11. **Drawing and file names.** The packet sheets on the design canvas and the three annexes are canonical; canon's working names map to them on the Design system v1 page.
12. **Popup onboarding counts rooms:** "Speakers answered in {{count}} rooms." The desktop uses "{{count}} rooms answered." in its Notice and "Rooms: {{count}} answered" in the checklist. The two apps keep separate locale files, so the voice pass (§12) should pick one wording for both.

**Audit calls (round 13 audit).** All reversible.

13. **Token-only specs.** T-size, T-line (`--line-hair`, `--line-bold`), the press scales, `--dur-step`, the `tokens.ts` timings and two fixed half steps (`--space-2-5`, `--space-3-5`) are added, so every number in an entry is a named token. Annex values on no step snap as listed under T-space; the artwork band is redrawn at the snapped rim.
14. **Removed as unused:** Checkbox `indeterminate`, Badge `count`, TextInput `busy`, Disclosure `as="button"`, Dialog `sheet`. Nothing in v1 uses them; each can come back when something does.
15. **One page title.** SectionHeader loses its `page` kind; PageHeader is every page's `h1`, including the options page's "Settings".
16. **One tone vocabulary.** NoticeLine's `neutral` is `info`, as on Notice.
17. **The options Toast sits in a StickyActionBar.** The separate "sticky toast row" had no scroll padding, so a focused control could sit under it (WCAG 2.4.11). Reusing the bar fixes that and removes a concept. `--z-sticky` now has one user.
18. **Language: one rule for both apps.** Hidden while there is one language; the options hint "English only, so far." retires (was owner call 11, now closed by the keep-it-simple rule).
19. **State coverage is written down** (§3, the matrix), including the Slider's track click for WCAG 2.5.7 and the Tooltip's 1.4.13 behaviour.
20. **The popup's version line is retired** for the record (the round 12 drawings still show it); the version is in Settings › About.
21. **Apps write no `@media` or `@container`.** Responsiveness lives in the shells and components, which keeps the lint to built-in rules.
22. **Enforcement is built-in rules plus one script** (`scripts/check-ds.ts`, which absorbs the planned `check-tokens.ts` and the layer check) and one catalogue.
23. **The drawing checkers are fixed, not worked around.** The contrast checker treated any colour with a blue channel of 0 as transparent; it now treats only alpha 0 as transparent, and the drawings show the toolbar badge at its token `#935d00` again. The overflow checker flagged visually hidden text as clipped; it now skips it.
24. **Settled design calls that were listed as owner calls:** Play and Pause are tonal; the fluid ramp tops out at 960; the popup list does not use subgrid; the popup header scrolls away; there is no "Cast again" (the CastBar is the retry); the room failure line keeps its X and wraps; the away line shows the lead, with the sentence as its spoken name (this is what "one line" means at 325 px); the options sections keep "Companion" and "Finer points"; the onboarding room wording goes to the voice pass. The row's name is settled as main's "Video sync" (video sync v1's copy pass), not "Sync video".
25. **Size and touch (Model C, owner decision, round 13 size pass).** sm is 32 on every surface and the default; md (36 popup, 44 window) is only for the action a view, step, bar or dialog exists for. Touch lives in hit areas: every window target reaches 44 by its `::after` or its native element, and the popup's hit floor rises to 44 under `any-pointer: coarse` (the Surface Go 2 is used as a touch device, the popup included), with nothing drawn changing. A read-only value is text with a compact Copy (Cloudflare's pattern), never a box. The Theme SegmentedControl comes down to a 32 track. The critic's four corrections are in: one question, not two (list rows belong to their components); TextInput and Select get their target from the native element, not an `::after`; IconButton loses its box floor; `--gap-target` is for touch accuracy, not 2.5.8. Built in Phase 2; the gap uses `--control-xs` (16 in a window), because a 28 X beside a 32 control needs it. The fallback, if the Go 2 tap test fails, is window `--control-sm` 2.25rem.
26. **"Copied" is brief (owner call).** A copy confirmation is a transient echo of the user's own action, so it may time out: it shows for `COPY_CONFIRM_MS` (2 s), then the action returns to rest, and it is said once, politely. The no-timers rule stays for messages people need time to read (Toasts, notices, a refused copy's note). This supersedes "done holds" in M-copy and P-copy and "the two copy-label timers" in §9 for this one case. The read-only value stays regular weight, and the Copy action stays quiet.

**CSS audit calls (round 13 CSS audit, owner accepted).** All reversible.

27. **The real floors.** The desktop's macOS floor is Safari 16.4 (macOS 13 with its Safari updates), not 16.0: the system relies on `color-mix()` (16.2), `@property` and `lh` (16.4), and writes no fallback for them. `tauri.conf.json` sets `minimumSystemVersion` 13.0 and the extension's manifest sets `minimum_chrome_version` 125, so the dropped fallbacks are guarded by the builds (§10, the floors).
28. **No `light-dark()` outside the token files.** The pairs components read are generated (T-colour, component pairs and `--{set}-glyph`), so `webkit-fallbacks.css` covers them; before this, 16 module-level pairs went invalid on the desktop's WebKit floor (the card hairline, the field fills, the heading and glyph inks).
29. **WebKit's press keeps its corner.** Without `corner-shape`, nothing reshapes, the pressed corner included; colour, the ring and the press scale carry hover, focus and press (F-grammar, round 6 "WebKit falls back to colour plus the ring").
30. **Numbers end-align.** Counts and live numbers are end-aligned, tabular, in a fixed `ch` box (F-shift, F-utils); the DescriptionList counts and the AddressField latency no longer override it with `start`. The box hugs the start of its cell, so the number still reads from the term's side.
31. **Page-level containers before the shells.** Until PopupShell, OptionsShell and DesktopShell land, the apps' own shell CSS declares them: the popup `body` is `app` (with the popup's inline size, since a container no longer sizes itself from its content), the options `body` is `app` and its column `content`, the desktop `#app` is `app` and `main` is `content`, the one scroller with a stable gutter and a `minmax(0, 1fr)` track. The desktop shell's one `@container` stays in the app until the DesktopShell owns it. The compact Wizard is as tall as its step (no 420 px frame, no inner scroller), so the popup document stays the only scroller.
32. **Settings rows on a subgrid, from 25rem.** Rows and Switches share the card's tracks (M-setrow), which aligns the controls and the help and removes the Switch-width inset under a bare row's note. Under 25rem they keep their own tracks.
33. **ChoiceGroup keeps plain auto-fit columns.** Its subgrid would only align descriptions across a row of options, and needs the Radio's inner text to subgrid two levels down; not simple enough to earn it (M-choice).
34. **The fold animates both ways where it can.** The Disclosure's height animates open and shut with `::details-content` and `interpolate-size` (Chromium 131, Safari 18.4), and is instant on the floors; it stays `<details>`. Its easing is `--ease-effects`, not the overshooting `--ease-spatial`.

**Polish pass calls (round 13 review of the Phase 0–2 build).** All reversible.

35. **Counts start where the words in their column start.** In a DescriptionList stat, counts share a column with the Address and with words, and end-aligned in a `ch` box they sat up to 12 px in from the text above. They are tabular and start-aligned; a number with a column of its own (a volume, the AddressField latency) stays end-aligned in its box. This amends call 30, and `--ch-count` is retired with it.
36. **Phase 1 decisions, moved here from the PR.** The Switch thumb sits `--space-2` inside the track, as drawn. Switch, Radio and Checkbox take a `description` and a `note`. Select and SegmentedControl render their own label (`hideLabel` hides it). Slider's `value` may be undefined while the level is unknown. Button takes `onClick` as well as `onAction`. IconButton's desktop Tooltip is its `tooltip` prop.
37. **Phase 2 decisions, moved here from the PR.** A Switch is its own settings row (SettingsRow then takes no label, and adds only the note, error and detail slots). A named SettingsRow is a group. ChoiceGroup and DescriptionList follow the `card` container; EmptyState is its own. Success notices are checklist lines, since Notice has no success tone. A notice with no lead is named by its text. The Toast's inverse inks are `--primary-container` and `--outline-variant`, which read as the other theme's on it. CopyField takes a `clipboard` (tests and the catalogue fake it) and, in the catalogue only, `confirmFor`, to hold "Copied" for review.
38. **Disabled comes from the native state.** Checkbox, Radio, Switch, TextInput, SegmentedControl, Slider and ChoiceGroup draw disabled from `:disabled`, not from their prop, so a disabled `<fieldset>` (RoomPicker while not connected, C-picker) draws everything inside it disabled. The catalogue shows one (Checkbox section).
39. **Locked is natively disabled.** A setting locked by an environment variable has its control natively disabled; the row is `aria-disabled`, and the note is text in the row, read with it. A keyboard user does not land on a control they cannot change, and the note says why. The alternative, a focusable read-only mode on Select, Switch and SegmentedControl, is three new modes for one note.
40. **The info tone reads the info set.** Notice and NoticeLine `info` use `--info-container`, `--on-info-container` and `--info-glyph`: unchanged in light, blue in dark, as T-colour has it. The success container and glyph stay unused (call 37).
41. **The SegmentedControl is a wide control.** At about 15.5rem it is over `--wide-control`, so the Theme row stacks it under the help below 45rem. As a narrow control it squeezed the name in a compact card ("Theme" read "Then") and, in a medium card, widened the shared control column and squeezed every row's help. The label track is `minmax(min-content, 1fr)`, so a name never shrinks under its longest word.
42. **A Switch row reads like every other row.** Its name sits on the switch's line at the row's label size; its description and note run under the name (across the row under 25rem, clear of the control column from 25rem, and in the help track from a 45rem card) at the help size, `--text-2`. From 45rem every row's name and help start on its control's line. A bare row's note follows the same tracks.
43. **A NoticeLine lead wraps when it must.** A lead with "Try again" or "{{count}} more" and an X fits one popup row only when it is short (about 20 characters at 13 px); a 34-character lead cannot. It wraps whole with plain wrapping (`pretty` broke short leads early, "Cast to / Bedroom ended") and is never cut off. This corrects M-noticeline's "fits one row"; the away line's words are still the lead alone (call 8).
44. **Toast actions can be async, and Esc has one owner.** Toast's action takes NoticeLine's shape (`label`, `onClick` or `onAction`, `labels`), so Undo can be busy and fail. A shown Tooltip takes its Esc (in the capture phase, default prevented); the Toast ignores an Esc that something open took (a tooltip, a dialog, a popover, an open select), so hiding a tooltip never throws away an Undo.
45. **Notice entrances stagger only in a list of notices.** `sibling-index()` counted every sibling, so a lone notice deep in a card waited. The stagger applies under a parent marked `data-notices` (the NoticeSlot, Phase 3), or from the `index` prop. The cap stays a literal (the third); RoomRow's cap of six is its own.
46. **Field wraps a TextInput.** Select and Slider carry their own label (call 36); around them a Field would name the control twice. They take `aria-describedby` for help.
47. **`100dvb` is an allowed literal.** L-desktop needs the shell as tall as the window; §10 row 1 now allows it, so Phase 5 does not fail on spec'd code.
48. **Flush quiet buttons, and the glyph stays with the words.** A quiet Button that starts a text column pulls back by its leading padding (`flush`), so its glyph lines up with the text: CopyField's Copy (beside the value the gap to its glyph is still `--gap-target`), Notice's Details under the text, the Wizard's Skip. After a glyph a Button's words start beside it; the room its longer busy, done or failed words need (F-shift) stays at the end rather than split around the words, so Stop's square no longer floats away from "Stop".
49. **Small additions Phase 3 needs.** Switch takes a `badge` inside its label (M-videosync: one name). Slider takes `mark` (StartLine's ghost tick) and `readout` (the value after the track in a `ch` box, "…" while unknown), which the "Start no louder than" detail now shows.
50. **A raw state never reaches a Badge.** The desktop's speaker badge maps each transport state the core sends (as serialised: `PAUSED_PLAYBACK` reads "Paused") to words; a state with no words shows no badge, and a test fails when the core adds one.
51. **The popup's interim parts keep the rules until Phase 3.** The old room list no longer scrolls inside the popup (L-popup: the document is the one scroller), and on artwork the cast card's ring gap is transparent, so the Slider handle draws no grey box round itself.
52. **The catalogue draws the WebKit floor.** `?floor=1` takes away what the desktop's floor lacks (`CSS.supports()` answers no, and the `@supports` blocks for `light-dark()`, `corner-shape`, `text-box`, `sibling-index()`, `field-sizing`, `::details-content`, base-select, anchor positioning and relative colour are dropped or unwrapped), so `webkit-fallbacks.css` and call 29 are rendered and tested (`tests/floor.pw.ts`, in both projects, with screenshots in CI).

**Owner feedback 1 calls (the catalogue review).** All reversible.

53. **One status colour per context.** The catalogue's #colour showed only each set's container, so the inks, which draw most status colour (dots, the Meter, error edges, the Clacks), were never on screen. Filled danger, the toolbar badge and an unused red ladder each added another red. Now components read generated `--tone-*` tokens in one of two pairs, `--danger` and the red ladder retire, the toolbar badge comes from the set, and #colour draws all four tokens of each set with their readers. The filled danger Button is `--danger-ink` (dark moves from `#f97770` to `#e88382`; `--on-danger` on it is 6.44:1), and the tonal danger and failed glyphs take the tone's glyph colour, so in dark they are the ink as every other glyph on a container is.
54. **Press keeps the bevel (owner).** A press used to swap to a smaller, round corner. It snapped, because `corner-shape` was not in the transition list, and the overshooting release made it flash. Press now holds the hover bevel, the 12 % layer and the scale say "pressed", `corner-shape` joins the transition list and the release eases out on `--ease-effects` with no overshoot. Controls that fill their line (Disclosure, the Select trigger, a full-width Button, NavItem) no longer scale, because a .98 scale moved a wide summary's words by 6 px. `--press-wide` and `--radius-thumb-pressed` retire. `--ease-spatial` stays only for the Switch thumb's slide and the StepIndicator pill, which are movements, not presses. Amends call 29 (WebKit: still no shape change).
55. **Select's shape moves into its list (owner).** The trigger is a field and never reshapes or scales: hover is the layer and an `--on-surface` edge, as TextInput. In the customisable list, an option that is not chosen takes the bevel on hover, focus and press; the chosen option stays calm, and its label's cell holds its strong width so the list never widens. Supersedes "the trigger follows the button grammar (`--press-wide`)".
56. **The chip × is an octagon (owner).** Its 3 px bevel read as a chipped square. It now takes IconButton's octagon (`--shape-bevel-short`, 8 px on 24) on hover, focus and press. A square icon-only control's bevel is about 30 % of its side. The other nested controls already were IconButtons (the Notice, NoticeLine and Toast X, Clear search, the icon-only Copy, Back, Mute and Remove) or rows that never reshape.
57. **The fold is smooth, and the summary stays still (owner).** The fold already used the modern CSS (`<details>`, `::details-content` with `interpolate-size` and `allow-discrete`). It stuttered because every Clacks animated a registered custom property on the main thread: 624 shutter animations in the catalogue took 390 ms of style work per 600 ms. The Clacks now animate only opacity and scale (sm only fades). The fold, a content fade and the chevron share `--dur-change` instead of a 480 ms height creeping behind a 268 ms chevron. A pressed summary no longer scales, which had moved its words by 6 px. `--dur-change` (`--dur-effects`, 0 under reduced motion) is added for every change of state that fades or folds. Amends call 34.
58. **The checkbox checks in one movement.** Only the input scaled, the check appeared at full size while the box sprang back past full size, and the corner snapped from round to bevel. Now the box and the check scale together, the bevel holds through the press, the release does not overshoot, and checking fades the fill in and grows the check from .6. The check is rounded to an even size, so it centres at both densities.
59. **The choice cross-fades (owner).** A segment's fill and its words now ease together over `--dur-change`, instead of the hover tint easing while the choice snapped. `--seg-bg` and `--seg-fg` are registered colours. There is no sliding indicator, which would need anchor positioning or script at the floors.
60. **Danger Buttons have every state (owner).** Stop and Stop all casts had no bevel, so they felt dead beside the other Buttons. They now take the full grammar (layer, bevel on hover, focus and press, ring and scale); nothing is shaped at rest. Amends §1 "Stop never reshapes".
61. **Button states cross-fade in a fixed box (owner; the fixed box is replaced by call 75).** A text-only Button grew a glyph slot when busy, and a set's check appeared and vanished, so both shifted the layout; the words and the failed fill snapped. Every state is now a glyph-and-words unit in one cell sized by the widest, the padding follows the idle unit, and a `pressed` Button always keeps its check slot. States cross-fade with a `--space-1` slide and come back the same way; the failed fill cross-fades with them (`--btn-bg` and `--btn-fg` are registered colours). Instant under reduced motion.
62. **The Meter stacks (owner).** The drawn and built one-line Meter broke: the native meter's parts disagreed on height, so the fill sat at the top of a taller track, and an empty glyph column indented the names. Now the name and value sit on one line over a full-width bar drawn by plain spans, with the native `<meter>` kept, visually hidden, for screen readers. One layout fits a RoomCard and a list alike. `data-meters`, the Meter subgrid and the glyph column retire.
63. **ChoiceGroup is the Radio, and the dot is whole (owner).** The catalogue's ChoiceGroup is drawn at desktop density, where the Radio's dot was 8.875 px and rendered off-centre. The dot is now rounded down to an even size (8 px in the 18 and 20 px boxes). ChoiceGroup's spec says it is a fieldset of Radio atoms and draws nothing of its own. The dot stays round, not an octagon: a ChoiceGroup always has a chosen option, so a shaped dot would be a shape at rest on every settings page, and at 8 px an octagon renders as a soft square, the checkbox's shape.
64. **The busy badge breathes evenly (owner).** The Clacks sat 5 px from the pill's end while 13 px of air sat after the words, and its md walk changed its visible weight. It now sits `--space-2-5` from the start and from the words, and its shutters fade without scaling.
65. **StatusDots share one slot (owner).** The dot, the Clacks and circle-x were 6 to 16 px wide, so the words beside them started at four places. Each state now sits centred in an `--icon-sm` square.
66. **The BrandBlock mark sits on the name (owner).** In the wide rail the mark was centred on the name and version together, so it sat between the two lines, off the name. The mark and the name now share one grid row, the mark centred on the name's letters, with the version under the name; the version's line is reserved while it loads. The header was already centred on the name.

**Owner feedback 1, after the independent review.** All reversible.

67. **A Button's states take turns, and sit centred (timing superseded by call 75).** The leaving and arriving words faded on one clock with a 2 px slide, so for about 100 ms they read as ghosted double text. The leaving unit now goes over half of `--dur-change` and the arriving one starts a third of it later, so they barely overlap. An idle Button with a glyph started at the box's edge and left the room its busy words need empty after "Cast"; every unit is now centred, its glyph beside its words. Amends call 48's "the room stays at the end".
68. **Busy keeps the pointer's shape.** Busy cleared hover's layer and bevel, so a Button clicked and still under the pointer went round and came back beveled at done, twice in the middle of the cross-fade, with no one doing anything. Busy now ignores only a press.
69. **The Switch's stretch has its own clock, and none under reduced motion.** The press stretch still ran under reduced motion, against "a press darkens without scaling". It is now off there. On a checked Switch the stretch's pull-back used the slide's spring, so the end edge, which should hold, wobbled by about a pixel; it is now a translate on the stretch's `--dur-fast`. The slide keeps its spring.
70. **A segment's words lead its fill.** Fading the words and the fill on one clock passed through a frame where both labels read faintly. The words now turn in a quarter of `--dur-change`, a fifth in, as the fill passes half-way.
71. **WebKit fades the fold's content.** The content fade sat in the same `@supports` as the height, so WebKit, which has `::details-content` but not `interpolate-size`, lost both, and the content popped in while the chevron turned. The fade now has its own `@supports`.
72. **The catalogue pauses what it cannot see.** The catalogue runs some 80 Clacks at once, so a fold dropped frames there (WebKit fell to 19 fps). A section out of view now pauses its animations. The product never draws that many, so nothing changes outside the catalogue.
73. **The Disclosure's layer is mixed on the summary.** `--disc-fill` was declared on the `<details>`, and `--layer` does not inherit, so the mix read the details' 0 % and hover, focus and press painted nothing: the hover bevel had no fill to show it. The mix now sits on the summary, so the fold shows the same 8 / 10 / 12 % layer and bevel as every other quiet control.
74. **A press scales the Button's surface, not its words (owner).** The whole Button scaled to .96, so its words were redrawn at 12.48 px. The engines snap text to the pixel grid, so the words did not shrink with the box: in Chromium they shrank smoothly and then popped back to full height as the press settled, and again on release; in WebKit only their width shrank. The fill, the edge and the layer now sit on a `::before` under the words, and only it scales; the words stay still and crisp in both engines. `will-change: scale` was rejected: it fixed Chromium only and cost a layer per Button.
75. **A Button fits what it shows, and its width morphs (owner feedback; decided).** Sizing every Button to its widest state (call 61) left a short result floating in a long box, worst going from long words to short (Restarting… to Restart Thaumic Cast in reverse, Knocking politely… to Added, Copy address to Copied), and short idle words carrying air at rest (Add speaker beside the field). Three prototypes were drawn on the real Button, every kind, in context, and recorded frame by frame in Chromium and WebKit. The Button now fits its current state and eases its width and start padding over `--dur-change`; the layout decides which side grows; the old words fade up and out by 0.4 of the change, held to the edge that stays, and the new ones fade in from 0.5, so the two never overlap (A-button, "Changing state"). Stop and Stop all casts drop "Stopping…": the square fades to the Clacks and the width holds, so "Ask again" beside Stop all no longer slides. F-shift is amended, call 61's fixed box is replaced, and call 67's timing is superseded. Rejected: keeping the words and swapping only the glyph (A), because short words carried dead air at rest, the words drifted as a glyph arrived, and the voice strings were lost; a view transition (C), because the neighbours jumped while the surface morphed, the old words spilled past the box, only one could run at a time, and it needs Safari 18. The catalogue's Button states section (`#button-states`) draws the result on every kind and in context.
76. **A change of state never moves the Button's line (owner).** Going busy grew the block holding a Button by half a pixel or more: a flex box takes its baseline from its first item, so the start slot's set the Button's baseline. An icon's foot and the Clacks' top row sit 3.5 to 5 px from the words' baseline, and a glyph-less Button gains a slot when it goes busy, so the Button rode higher on its line and the line box grew (0.5 px for sm in a 22 px line, up to 8 px for a link, whose box is its line). The start slot is now held out of the flow, in room the unit's start padding keeps for it, and the unit is always as tall as the slot, so every state keeps one block size and the words' baseline (A-button, "Changing state"; F-shift). The catalogue's Button states section draws every kind in both sizes and densities, with and without a glyph, and a test samples the Button, its parent and its row every frame through busy, done and failed in Chromium and WebKit. A Badge already held: its box is fixed and it sits `vertical-align: middle`. Rejected: reordering the slot and the words with `order` or a reversed row, because both engines take the baseline from the item drawn first; layout containment on the slot or the unit, because it moves a glyph-less Button's baseline off its words.
77. **Shapes on focus and press; hover is colour (owner).** The owner tried a catalogue prototype of the bevel tied to the press and kept it, with one change: "I think the focus state should still show the octagon". Hover is now the layer only and never reshapes. Focus-visible is the bevel with the ring, which traces it. A press morphs the surface to the bevel and back, from rest (or it is already there when focused), and the press scale is gone everywhere: `--press-text` and `--press-icon` retire, and so do the Button's surface scale (call 74), the IconButton, chip × and segment scales and the checkbox box's. A press always plays the whole morph: `:active` ended before a quick click's corner had moved, and Enter never set it, so one shared utility (`src/utils/press.ts`) holds `data-pressing` from the press until the later of the release and the end of the morph, for pointers and for the keys each control takes, and skips disabled and busy controls. Under reduced motion the shape swaps at once and the hold ends with the release. Calls made with it: a busy Button, IconButton or Switch keeps the bevel while focused but ignores a press, so it stays round under the pointer (amends call 68: hover's bevel is gone, so busy under the pointer is round); a chosen segment and a chosen Select option take the bevel on focus and press like any control, so a press that chooses plays the whole morph, and stay calm at rest (amends call 55); the Select's options are not held, because choosing closes the list; the Switch thumb's press stretch and the Slider handle's narrowing stay, because they happen inside a track that keeps its size; text inputs, the Select trigger, Radio, rows and containers still never reshape. Supersedes the hover bevel of calls 54, 56, 58 and 60 and the press scale of calls 13, 54, 58, 60 and 74. Without `corner-shape` nothing reshapes, as before (call 29). The prototype's switches and lab are replaced by the catalogue's Press and focus section (`#press-states`).
78. **A press plays out, and a mouse-opened list stays calm (review of call 77).** Two gaps the independent review found. (1) An `onAction` Button goes busy on the click, so `aria-disabled` arrived with the release and the press rule dropped the bevel mid-morph: a quick click on Connect, Cast, Stop or Add speaker turned its corners part-way and back, the half-morph call 77 removed. A held press (`data-pressing`) now keeps the bevel and the 12 % layer on a busy Button, IconButton or Switch; a press that starts while busy is never held, so busy under the pointer is still round. The bevel and the layer then return together and the Button settles on hover's layer. (2) Chromium focuses the chosen option whenever a customisable list opens and matches it as `:focus-visible` even for a mouse open, so every mouse open drew the chosen option beveled and ringed. The Select marks a pointer open (`data-pointer`, cleared by any key), and while it is set no option shows focus; a keyboard open, or a key after a mouse open, shows the bevel and the ring on the focused option, chosen or not. Rejected: keeping the chosen option calm on focus for everyone, because then keyboard focus would lose the octagon on the one option every keyboard open lands on. Also: under reduced motion a press is held for at least one drawn frame, the catalogue's forced segment rows now draw on the segments, and the Press and focus section gains forced rows for every shaped atom and live busy, async and link Buttons.
79. **Shaped controls fade painted colours, not registered properties (final verification of call 77).** Frame recordings in WebKit (Playwright's trunk build, the first WebKit here with `corner-shape`; Safari 27 is likely to ship it) showed a press snapping to the bevel and the radius snapping back, on every control whose layer and corner live on the same element (Button, IconButton, chip ×, segment, NavItem, Disclosure, Select option), while the Switch thumb and the checkbox box, whose layer sits on another element, morphed smoothly. Bisected on the real Button: WebKit drops the `border-radius` and `corner-shape` transitions while a registered custom property (`--layer`, and on a choice `--seg-bg` and `--seg-fg`) transitions on the same element; a plain test page does not reproduce it, so it is not reported upstream yet. These controls now transition `background-color` (a Button on its surface, `::before`) and `color` instead, which looks the same in Chromium, keeps every duration and easing, and gives WebKit the whole morph. One small change: under reduced motion a segment's hover tint now switches at once with its choice (`--dur-change` is 0), where it used to fade. The registrations stay, for controls that do not reshape.
80. **A flush Button's cap includes its pull (owner: "on CopyField the button transition jumps").** A Button is capped at `max-inline-size: 100%`, and a flush one reaches back by `--btn-pull` (10 px at sm on the desktop). In a box that hugs it, as CopyField's action does, that box is the Button's margin box, so 100 % is the Button's width less the pull: at rest the Button sat 10 px narrower than its content, and while a change set its `inline-size` the cap took the pull off every frame, so Copy address to Copied ran 10 px short and snapped by 10 px on the first and the last frame (the words by 5), in Chromium and WebKit, in every CopyField. The `#button-states` Copy sits straight in a wide row, where the cap never bites. The cap is now `calc(100% + var(--btn-pull))`, which is `100%` for every Button that is not flush. A test presses every CopyField on the catalogue page at once and samples each frame through Copy, Copied and back, and through a refusal: the width turns once, never overshoots, and the value, the row and the field hold. Rejected: changing CopyField's wrapper, because any flush Button in a hugging box would still be squeezed.
81. **No scrollbar gutter on a popover or a short list (owner).** On Windows, Brave's open Select list showed an empty strip at its end: `scrollbar-gutter: stable` on `::picker(select)` keeps room for a classic scrollbar even when nothing overflows, and the list rarely scrolls and holds nothing that must not shift. It is removed there; the gutter stays on the page scrollers (the popup and options documents, the desktop main, the full Wizard's content), where a scrollbar arriving would narrow the page. F-shift is amended. No other popover or list sets it.
82. **Phase 3 decisions, moved here from the PRs.** The popup is built speaker-free: nothing in it regroups a Sonos group, so the round 12 hardware tests still come before that work. Each call below is reversible. Call 84 supersedes the interim cast, GroupVolume and add bullets and "Play speakers as one group stays": they now hold only for an older companion that cannot regroup.
    - **The interim cast.** A chosen room casts to its whole Sonos group, through the coordinator, as one row per group did before. When grouped partners play too, the CastBar line says so once: "Patio plays too, as it is grouped with Kitchen." / "Patio and Study play too, as they are grouped with your rooms." (`cast_plays_too_*`, interim). Chosen rooms that are exactly a group add no line. Regrouping fills the cast plan's `leaving` list, swaps the line for `cast_leaves_group_*` and drops this string.
    - **The interim GroupVolume.** A running cast has one row per target, so a Sonos group cast as one target is one row named "Kitchen + Patio"; the fold label counts rooms, not rows. On a cast joined into one Sonos group ("Play speakers as one group") the master is the group's volume for the joined rooms, and a room added later (which plays outside that group) moves by the same ratio beside it; otherwise it moves each row by the same ratio in the popup (`scaleLevels`), and its value is the mean of the known levels. Each room belongs to one row, the target that is the room itself before the target whose group it is in, so a joined cast keeps one row per room it was sent to.
    - **The interim add.** An added room plays the cast on its own stream, as a cast to several rooms does with "Play speakers as one group" off; joining it to the cast's group is the regrouping work. Its row says "Joining…" until the background answers (the popup waits 35 s, past the background's own 30 s worst case), then a row line for a room that did not join. That row's controls stay live, as annex 2 draws, and its Remove forgets it. Undo after Remove re-adds the rooms the same way, once the removal has landed, each at its own level before Remove (a room whose own level was not known starts by the limit rule), never at its group's. Playback starts on one stream run one at a time, so an add, an Undo and a Try again never take each other's results.
    - **Rooms on the wire** are the companion's groups plus `invisible` on bonded members; one protocol function (`roomsOf`) derives the rooms for the popup and the background, and an older companion folds by room name.
    - **Room levels.** A room alone in its Sonos group shows its live level; a room inside a bigger group shows "…" until Cast, when the companion reads it.
    - **Chosen on open** is Last cast's rooms that are here, else the first room no other client casts to; the choice is not stored until a cast starts, and the old selection by IP migrates into Last cast once.
    - **Sets store each room's name with its id,** so a set whose room is missing still names it on its line ("Garden is not answering; Study goes alone."), with no ghost row; a set none of whose rooms is here is not offered. RoomRow `unavailable` is built and catalogued, and unused until the companion reports a room that does not answer. Sets can be made in Phase 3 and removed only from SetList in Phase 4, which lands in the same stack before any release.
    - **A single cast is open with no chevron** whichever tab it is from (C-casttile over annex 2's "on its own tab"); with several, this tab's is open and the others compact, each remembered for the popup session.
    - **No "Stopping…"** on Stop (call 75 over M-media and annex 2).
    - **Strings land in Phase 3,** not Phase 5 as §14 had it, because the popup needs them; the voice pass may still change their values. #233's start-level keys stand for annex 2's (`start_level_speaker`, `volume_fixed`, `volume_fixed_hint`, `start_level_unknown`), with annex 2's spoken values; `volume_fixed_hint` and `start_level_unknown` are spoken only now. `error_no_speakers_selected` speaks of rooms. Three keys the annexes do not list: `start_level_starts_at` ("starts at {{start}}", spoken after an unchosen room's name), `room_condition` ("{{name}}: {{word}}", a room's condition in the fold's summary) and `away_more` ("{{count}} more", one form, since one event reads "Details"). The CastBar leads are `castbar_lead_*` by the error they stand for, and the banner leads `notice_lead_*`.
    - **#233's options control** is the M-setrow Switch "Start no louder than" with a detail Slider, not a Select.
    - **StartVolume is keyed by room** (`rooms` by player UUID), replacing #233's unreleased `speakers` by IP.
    - **The badge theme** comes from a session flag the popup and the offscreen document write; the service worker has no `matchMedia`. **Live or shut** for the away log is decided by the popup's port.
    - **"Play speakers as one group" stays** until regrouping replaces it, against §9's retired list. (Retired by call 84.)
    - **Hover never reshapes** StartLevel's button or the rows (call 77 over annex 2's state tables).
    - **Notices at the source** are placed by one pure function (`lib/popup-notices.ts`) for the conditions: the banner (with `also`), the section notice, each cast's slot, and the room Badges. The events the open popup sees (a failed Cast, a room still playing or not joined, a room that left, an auto-stop) are held where they happened: the CastBar line, the row line, the tile note and the Toast. With nothing casting, "No reply from the speakers" sits first in the content, since "Cast to" is the picker's legend inside the TabCard. An auto-stop's Toast reads its lead, then the shipped sentence; the Toast and "Cast to {{name}} stopped." name the cast's rooms, and so does the away log ("Cast to Bedroom ended").
    - **Not connected, the Cast button reads "Cast"** with no count, as the CastBar table has it, and its line is empty.
    - **The component calls** (from building them): an unchosen room's number is spoken "starts at {{start}}"; the band's colours come from the artwork's hue and chroma (`--art-h`, `--art-c`) with per-theme `--seed-*` lightness and chroma caps, in place of one `--art-seed`, falling back to the container colour with a hairline rim where relative colour is missing; a fixed output's value stays at full ink (annex 2's 38 % fails 1.4.3) while the disabled slider still shows it cannot change; RoomRow `pick` is built on the Checkbox atom, so the hover tint stops before the start-level button; the media title is the body face at 600 in both forms; the header's description is read, not shown; a list row's disc is Artwork md; CastBar takes the finished label, and rows take display-ready words. Slider takes `valueText`, Button takes `aria-controls` and its trailing word no longer wraps, Card takes `labelledBy`, and `SEARCH_SETTLE_MS` (500) is a script timing. No gap decorations: Dividers were simpler for the few dividers there are.
    - **The shell is its own scroller,** not the document, and it is the containing block of what is positioned inside it (`position: relative`): a visually hidden label or a native input held out of the flow otherwise counted against the document, which then scrolled as well. Without a shell (the options page), the bar falls back to the document as its scroller.
    - **The picker's fold spans the card,** as its rows do: its trigger keeps its padding without the bleed, which lines its chevron up with the rows' boxes. Bleeding the rows back out of an inset fold put the level button past the fold's clip, which cut it off in Chromium.

83. **Phase 3 review fixes (independent visual and spec reviews).** Each is the simplest call where the spec was silent, and each is reversible.
    - **Focus never falls to the page (2.4.3).** When the focused control goes away, PopupShell moves focus to the next control that was after it, else the nearest before it (`utils/focus.ts`): a notice's X, the Toast's X and Undo, a row line's X. Where a better place is known the component moves focus first: "Save these rooms as a set" opens on the name field and Cancel goes back to it, a saved set takes focus as it appears pressed, an invalid save focuses the name (P-forms), and the add mode's Cancel and Add give focus back to "Add a room".
    - **The popup pads its end** by `--space-4` when no bar or end row follows the content (L-popup), and the bar's `--surface` reaches the scrollbar gutter: the shell's own background is `--surface` for `--overlay-end` at its end (none under an end row).
    - **"Add a room" brings the add list into view** above the bar its add mode brings in, once the bar is in and again once a fold round it has grown.
    - **A tile opens and shuts at once.** The head row keeps the band's place and padding in the compact form too, so the artwork and Stop sit at one spot in both forms; what the open form mounts makes no entrance, which read as a flash in a body already full height. The tile's chevron is the Disclosure's: down while shut, up while open.
    - **Stop takes the bevel on focus and on press,** as every Button does (A-button, call 77); "never reshapes" in C-casttile means it never changes place or size. The review saw no press bevel because its frames paused the transition; a held press draws it in both engines.
    - **A set's trailing word sits at the row's end** in `--on-surface-variant`, trimmed like the label so they share a centre line, and a set's name is in `--on-surface` (pressed, the on colours), as the round 12 drawings have it. Whether the label should name the rooms, as one drawing does, was left to the voice pass; the owner's answer is the count only, for every set, a saved set's too (call 84).
    - **"…" on a chosen room is a LevelButton** while the limit is on: its StartLine starts at the limit, so the start can still be set by hand. With the limit off "…" stays text, having no number to start from; "Fixed" is always text (amends M-startlevel's text forms).
    - **A joining row keeps its columns:** mute and the slider drawn disabled, the Remove column kept empty, and "…" when its level is not known.
    - **Notice lines line up with their first line:** the glyph, the action and the X sit centred on it, so a wrapped lead grows downwards. The CastBar's parts sit `--space-3` apart, wider than the focus ring. The header's checking Clacks keep `--space-2` from the words. WebKit's native search cancel glyph is hidden. The away list wraps plainly.
    - **With nothing to choose** (no rooms, still asking, not connected) the CastBar says nothing; the picker's EmptyState says why.
    - **"No reply" dismissed is kept** until the speakers answer again, so the toolbar badge drops it too. A stale group level is dropped when its speaker stops leading a group, so a room that joined another group reads "…", not its old group's level. The popup's port to the background is opened again after a service worker restart, so events seen live stay out of the away line. A failed Stop keeps focus where it is.
    - **Left as they are:** a row line arriving pushes the rows under it (T-motion: only the line itself moves in); the live dot on a light band is decorative and the pause glyph carries the state; the unchosen level digits and the master's readout keep their own columns.

84. **Regrouping, the update mark and the set label (owner calls 1 to 3 of the Phase 3 report, and the round 12 hardware results).** It supersedes call 82's interim bullets, which hold only for an older companion.
    - **A cast is its chosen rooms, as one Sonos group.** With a companion whose `/health` says `regroup`, the cast plan sends each chosen room's own IP and UUID (`START_PLAYBACK` `rooms`), and the companion makes the group: the exact group plays through its coordinator; otherwise a group made only of chosen rooms leads, and every other room goes standalone, gets its start level (min(current, limit) or the hand-set level), then joins. Nothing touches a speaker before Cast, a satellite is never named, and the start level is set before the join.
    - **Moved rooms go back on Stop and Remove, guarded.** The companion reads the grouping fresh and puts a room back only if it is still in the cast's group, rejoining its old partners' current coordinator without a Play (hardware: it plays on its own). Nothing is put back after a source change or a takeover; a source change on the coordinator ends its followers' sessions too. A room that cannot leave stays where it is, and the room it still follows is not put back. A Stop waits for a Cast still joining rooms, so none is stranded, and Stop all casts counts its few seconds only from then. A room the companion is itself stopping, handing on or putting back is never read as a source change, so a NOTIFY mid-Remove cannot end the cast. When no speaker reports the grouping, a Cast moves nothing and fails; an older extension hears only of the speakers it named.
    - **The CastBar says what moves:** "{{name}} leaves its Sonos group until you stop." / "{{names}} leave their Sonos groups until you stop." for chosen rooms in a group that holds unchosen ones, then "Music in {{names}} starts again from the top." (NEW) for unchosen rooms whose playing group's coordinator is chosen (hardware: the promoted room restarts from 0:00), then the replace hint, left out when the restarts sentence shows: "Whatever the speaker is playing will stop." right after a room whose music plays on would make "stop" mean two things (a cast that ends is still said). Add mode says the same for the rooms being added. The bar takes at most three sentences, and they grow it only on the user's own choice (its first line is no longer reserved: call 88).
    - **Adding joins the cast's group,** by `rooms` again; "Joining…" until the room answers, then "did not join" with Try again. A room that did not start at Cast gets the same row line. Remove leaves and restores; Undo re-adds each room at its own level.
    - **One group, one master.** A regrouped cast has one row per room; the master moves every room in the first room's current group by the group's volume, in any order, and a room still joining on its own. A regrouped cast's rooms are read by their own levels, the coordinator's included (`roomLevel` `own`). Before Cast a room inside a bigger group still reads "…".
    - **An older companion** keeps call 82's interim cast, add and "plays too" line, since sending it a member's own IP would pull the member out of its group with nothing to put it back. `regroup` is read at discovery and on every cached `/health` check, and drops to false when an older companion answers at the same address. The fallback goes once the extension requires a companion that regroups.
    - **"Play speakers as one group" is retired** (§9): a cast to several rooms is always one group with a companion that regroups. A stored value is dropped on the next save; `syncSpeakers` stays on the wire for older extensions and on a session, where it means "plays as one Sonos group".
    - **Playback starts carry a call id** (`${streamId}:${n}`), which a regrouping companion echoes, so a late reply is never taken as a retry's; a reply with no id falls back to the speaker filter.
    - **"Update available" is a mark on Settings** (owner call 3: "only if it is subtle"). IconButton `mark` draws the dot; the button is named "Settings, update available" (NEW) with its Tooltip and opens Settings at About, where the link is. It takes no space and moves nothing. The second status line was drawn beside it in the catalogue (`#update-available`) and not built: the header would grow under the pointer when the version check lands, or keep an empty line on every open. The end row, and call 83's end padding under it, are removed.
    - **A set's label is its room count** (owner: "just count"), a saved set's too; `saved_set` is retired.
    - **Call 83's three items left as they are stay as they are.**
85. **Fixes from the owner's test of the built extension (real speakers, Windows).** Reviews until now used the catalogue and the popup with stubbed Chrome APIs at a fixed viewport, so they missed what only the built popup shows; each fix is checked in the built popup too.
    - **The header and main are one column (owner: "`<main>` and `<header>` block sizes are not the same"; "the header does not seem to be following … the same components we created for it").** The PopupHeader padded its inline edges by `--space-3-5` inside the shell's padding, so its mark and Settings sat 10 px inside the edges "Casting now" and the cards keep, and the catalogue drew it inside a card, where that inset looked right. It now takes the content's edges (C-popupheader), and the catalogue draws it on the popup's ground. The real popup builds it from PopupHeader alone; there is no other header markup.
    - **The scrollbar is thin again, and its gutter is balanced (owner: "in v1 the scrollbar we were using thin styles"; "gutter stable but only one side so it does not balance").** v1 set `scrollbar-width: thin` on its lists; the CSS audit removed those as local overrides and nothing replaced them, and `scrollbar-gutter: stable` reserved the classic scrollbar's width at the inline end only, so the header and the cards sat off centre by it. Both are now one foundation in `base.css` (F-shift): thin everywhere, and `stable both-edges` on every `data-scroller`. stylelint keeps every other file from styling a scrollbar.
    - **An added room shows its own level (owner: "an added speaker can sometimes not render the volume slider").** The companion reads a joining room's own level (RenderingControl) as it joins, usually before the topology shows the room no longer leading its old group, and the extension then dropped that entry as a stale group level; RenderingControl does not notify again until the level changes, so the row kept "…" and an empty slider. The companion marks a room's own volume and mute `own`, and the extension keeps an own entry when its speaker stops leading a group.
    - **The fold never cuts a flush Button (owner: "the Add a room button is cut off on the left side").** The Disclosure clipped both axes of its content to animate its height, so "Add a room", which reaches back by its pull, lost its surface's start. It clips the block axis only (M-disclosure).
    - **One set row reads selected (owner: "We should just select one").** Last cast and a saved set (or Everywhere) both read pressed when the last cast went to those rooms. Everywhere wins, then the first saved set, then Last cast (C-picker).
    - **A new set is listed once (owner: "when saving a new room it will add it twice on first add").** The storage change the save fires can show the new set before the save resolves, and the save then added it again. The popup now shows the sets as stored, and a second submit during a save is ignored.
86. **The real-extension check, and what it found.** Call 85's fixes were checked in the built popup with stubbed Chrome APIs, which is still not what ships. `apps/extension/real-ext/` now runs the built extension unpacked in real Chromium, with its real toolbar popup and real tab capture, against the real companion on a fake household that sends the events real speakers send; `run.sh` walks the popup and checks each item below at 100 % light and 125 % dark. Popup and options work is checked there before it goes to review.
    - **An added room's level, again.** Call 85's fix held only when the room's first RenderingControl event arrived. That event can reach the companion before its subscribe reply is handled, and is then dropped as an unknown subscription; the room sent nothing more while its level stayed put. The companion now reads each joining room's own level and mute once it follows them, and sends them as `own`.
    - **The root's gutters are the ground** (F-shift), not white beside it on the onboarding popup and the options page.
    - **The CastTile's head row holds its place open without a band** (C-casttile): open on a cast with no artwork, Stop had ended 2 px from the card's border.
    - **A second tab never takes over another cast by default** (P-picker), and a room in one of this browser's casts reads its own level in the picker, as its tile row does. The first-ever choice is a free room alone in its group, not the first by name.
    - **A speaker that drops off the network is said on its cast:** a "Not answering" Badge on its row and a standing slot line, "Office is not answering". While the companion is reconnecting the picker waits, and while it is not connected no room shows who plays or casts there.
    - **Smaller:** the partial set line agrees in number ("go alone"); onboarding lists rooms, not groups; Last cast is not listed beside a set of the same rooms (C-picker); a live region empties after `ANNOUNCE_HOLD_MS` and the popup says which rooms joined (A-announcer); a Toast with no bar sits on the ground (L-bar); the popup's document no longer overflows by a pixel (F-shift); and a room put back after a cast follows its old coordinator to the group that coordinator rejoins, rather than being left alone.
    - **Left open:** "Add a room"'s focus ring meets the card's border. Its flush pull leaves 4 px between the button and the card's inner edge, the ring's width. Either a flush Button draws its ring inset, or a CastTile's body keeps more inset than `--space-4`; both touch every flush Button, so it waits for a decision rather than a local fix.

87. **Behaviour fixes from the owner's second test of the built extension (real speakers, Windows).** None changes a drawing or a string.
    - **A room reads "In use" only when something else plays on it (owner: "a speaker will report itself as 'in use' but not be 'in use'").** Two causes. The extension threw away the Stopped a room reported as it left a cast when the companion's "left the cast" landed inside the 500 ms transport debounce, so the room kept reading Playing; the pending state is now recorded when the room leaves. And a room's AVTransport subscription goes while it follows another room, so its recorded state stays the PLAYING it gave in the cast; when it leads again it is subscribed afresh and the first event can be lost to the subscribe race. The companion now reads a newly subscribed speaker's transport when it has one recorded, and reports it if it differs.
    - **A cast plays on when another cast takes one of its rooms (owner: "the first tab's cast will close … Sometimes").** Taking the room leading a cast stopped its followers with it, or left Sonos to promote one unseen, which the companion then read as a source change and ended the cast: whether that NOTIFY arrived decided it. The cast is now handed on to a room it keeps first, as Remove does; a taken follower leaves its group and is never sent its group's Stop. Its tile drops the taken room alone.
    - **Every room of a cast shows its level (owner: "sometimes the volume slider cannot initialize").** A cast to one room never had its room's own level read or followed, so a room that left its group to play alone (no level of its own on record) or one whose first group event was lost showed "…" for as long as it played; it now enters the sync session like a cast to several rooms. A joining room's level read is retried once. A room switched to other music leaves the sync session even when nothing follows it.
    - **The real-extension check loops rooms in and out of casts** (`real-ext/rooms.mjs`) with every new subscription's first event lost, and fails on the old core as the owner saw it. "Go to tab" closing the popup is Chrome's: an action popup closes whenever its window's active tab changes. The service worker can reopen it over the new tab (`chrome.action.openPopup()`, checked in the real-extension rig); whether to is an owner call, so it is not built.

88. **Fixes from the owner's third test of the built extension (real speakers, Windows).** Each is checked in the real-extension rig (`real-ext/check.mjs`), at 100 % and 125 %, light and dark.
    - **The onboarding takes the main popup's padding and never changes size (owner: "the content seems to have inline padding that makes everything tight"; "the popup block size jumps all over the place"; "the dialog also seems to have a large padding").** The compact Wizard padded itself by `--space-6` and its content by `--space-6` again, so a step sat about 50 px inside each edge; and it was as tall as its step, so Chromium resized the popup on every step. The popup's padding is not fluid: the PopupShell's is `--space-4` (L-popup); the fluid steps (`--space-5` up) are layout steps for windows and resolve to their minimum in a 352 px popup anyway. The compact Wizard is now the PopupShell's frame without the header (L-wizard): `--space-4` padding and gap, no inset of its own, as tall as the popup can be on every step, the one scroller, with Skip and Carry on in a StickyActionBar. A short step leaves the ground under it; a long one (many rooms, the manual address) scrolls under the bar.
    - **The open tile's band reaches the card's edges (owner: "there shouldn't be padding space (inline and block-start) showing the surface behind it").** The tile inset its head row by `--space-1`, so a strip of the card's surface showed round the band. The band now bleeds to the card's top and sides, on the card's inner corner (`--radius-card` less the card's `--line-hair`), and takes the inset into its own padding, so the artwork, the words and Stop sit where the compact tile has them. The rig's tone page now has artwork, so its open tile draws a band.
    - **No Go to tab on the cast's own tab (owner: "if we're on the tab we shouldn't show the button").** The popup reads the tab it opened over once (Chrome closes it when that changes) and leaves Go to tab off that cast's tile.
    - **No "Add a room" with nothing to add (owner: "if all speakers are already added should we hide the option?").** Yes: with every room in the cast or joining it, the tile has no "Add a room", and an open add mode shuts with the CastBar's add mode. A room leaving brings it back. No new string.
    - **Rows take the octagon on press and focus (owner: "the press state does not have an octagon on press"; decision: rows reshape like every other pressable).** This reverses the "rows never reshape" exception (§1, F-grammar, calls 77 and 83). The Checkbox row (so RoomRow `pick` and the add list) and the Radio option (so ChoiceGroup) rest on `--radius-control` and take `--shape-bevel` on focus-visible and on press, held for the morph (the Radio option now takes the press hold too); the checkbox's box keeps its small bevel and the radio stays round. They fade the painted colour, not `--layer` (call 79). Set rows are Buttons and already did. Text inputs, the Select trigger and containers still never reshape; a `cast` row is not one control, so its parts (mute, the Slider, Remove) keep their own grammar.
    - **Saved sets can be removed (owner: "how does a user delete one?").** SetList (C-setlist) is built and lives in Settings › Saved sets, after the audio settings: each saved set with its room count, Rename (in place, the name selected; an empty name is refused, P-forms; Cancel and Save give focus back to Rename) and Remove (at once, no confirm; a StickyActionBar at the page's end holds the Toast, "{{name}} removed." with Undo, which puts the set back at its place; the bar is drawn only while the Toast shows). With no sets it is an EmptyState. The popup is unchanged. NEW strings, for the voice pass: "Saved sets", "No sets yet", "Choose some rooms in the popup and save them as a set. They turn up here, to be renamed or thrown out.", "Rename", "Rename {{name}}", "Remove", "Remove {{name}}", "{{name}} removed."
    - **No empty line under Cast (owner: "has an empty paragraph creating an empty space when no message").** The CastBar kept its polite line's first line reserved, so an empty paragraph sat under Cast whenever there was nothing to say. It now draws the line only while it has words, with the notices' entrance (from `--space-2` below, faded; T-motion). A line arriving grows the bar, which only the user's own choice of rooms does, so nothing moves on its own.

89. **Fixes from the round 2 review of call 88, in the real extension.** Checked in the rig at 100 % light and 125 % dark.
    - **A long set name never widens the popup.** A set name has no length limit, and a start-aligned Button (a set row) kept its label on one line, so a long name ran past the card and the popup scrolled sideways. A list row's label now wraps (`overflow-wrap: anywhere`) and is never cut off, as every name in the system is; the row takes `--space-2` block padding so a wrapped name has room, and its trailing count keeps its line. In Settings a long name wraps beside Rename and Remove, as a short one sits; the actions go under the words only on a row too narrow for 12rem of words beside them. Rejected: a length limit, which needs a new error string for something nobody types twice.
    - **Cast stays put when the CastBar's line comes and goes.** The popup's height follows its content up to `--popup-block-max`. A short popup grows downward, so a line under Cast leaves Cast where it was; a popup at its tallest grows the bar upward, so the same line pushed Cast up by its height (40 px) under the pointer. While the popup's scroller scrolls (a `scroll-state(scrollable: block)` query on the PopupShell), the line sits above Cast instead. Moving it never changes the bar's size, so it cannot flip the query. A popup that the line itself takes to its tallest still moves Cast, by what it had left to grow, always less than the line. Without scroll-state queries (Chrome before 133, the WebKit floor) the line stays under Cast. Rejected: an overlay above the bar, which would cover the room just ticked in a short popup with nothing to scroll.
    - **Escape cancels Rename in Settings** and goes no further (the page's Toast also listens for it).
    - **A room left with another room's music reads "In use".** When the room leading a group that plays music joins a cast, Sonos hands the music to a room it leaves, which has only ever followed and so has no transport state on record; with that room's first event lost it read as free while it played. The companion now reads every newly subscribed coordinator's transport, not only those with a state on record, and reports it when it differs. While no speaker has reported anything at all it still reads none, so the empty cache keeps telling a refresh that no event reaches us (the degraded banner).
    - **The popup that takes a room says nothing about it on the other cast's tile.** A second tab's popup that took rooms from the first cast put "{{name}} left this cast" on the first cast's tile, naming one room: the user's own doing, already seen on both tiles. The popup now skips that note for a room it cast to itself. The first tab still has it in its away line.

90. **Fixes from the owner's round 3 test of the built extension (real speakers, Windows, dark).** Each is checked in the real-extension rig (`real-ext/check.mjs`) at 100 % and 125 %, light and dark, and each new check fails on the code before it.
    - **The onboarding is visibly the main popup (owner: "the layouts on onboarding now look visually broken, e.g. padding that does not match the rest of the popup").** The compact Wizard drew its own frame: the step indicator sat in a row as tall as its dots, jammed at the top; the step and its body sat straight on the ground at the frame's padding, so their text edge was the cards' outer edge, 11 px outside the main popup's text; the body's paragraphs, the footnote and the status lines each set their own type in the app; the checklist's dot sat in an `--icon-md` box, inset from the edge. It is now the main popup's own frame (L-wizard): a PopupShell `fill`, whose header row is the PopupHeader's size (Back on the content's start edge, the StepIndicator centred, a Back-wide slot opposite, kept on step 1), the step in a Card on the main popup's card edges and starting where its first card starts, and Skip and Carry on in the same StickyActionBar as Cast. In the popup the Card's inline padding is the flush cards' head inset (C-card), so the step's header, paragraphs, notices, status lines and buttons share the main popup's text edge. WizardStep sets the body's type (`--text-3` in the popup; a `note` for the footnote) and its parts sit `--space-4` apart, so the steps have no CSS of their own. A checklist's StatusDot square sits on the edge (M-dl), as in the PopupHeader. A flush Button now pulls back by its border as well as its padding, so Skip's words start where Cast's box does (A-button). The rig walks every step and state (welcome, the companion found, not found, the address given by hand, connected by hand, the speakers, ready) and checks each against the main popup within 0.5 px: the Card's edges and top, every part on the content edge, the header row's box, Back's place and the indicator's centre, and the bar's box, padding and surface with Carry on ending and Skip's words starting where Cast does.
    - **A cast's rows line up whatever their state (owner: "when joining speakers the disabled states' inline sizes are wrong").** A joining row kept an empty Remove slot, but the room playing alone (the last room, which has no Remove because Stop ends the cast) kept none, so its Slider ran 40 px further than the Joining… rows beside it. Every cast row's volume line now has fixed tracks, mute | Slider | Remove slot, with the slot always there, holding Remove or nothing (M-roomrow); the master and the compact tile, which have nothing after the value, have no slot. The popup list still does not use subgrid (F-grid): fixed tracks give every row the same columns. The rig adds two rooms that answer slowly (the companion's new `/slow` control) to a room playing alone, and checks every row's Slider has one inline start and end while they join and once they have joined.
    - **The CastBar's line is always above Cast (owner: "the position of the message next to the cast button changes when there is at least one cast tab").** Call 89 put it under Cast in a short popup and above it at full height, so it changed sides between states (a cast tile makes the popup tall). It now sits above Cast (or Add) in every state, before it in the reading order, and opens in place: its block size runs from 0 together with the gap above Cast (where `interpolate-size` exists; elsewhere it opens at once), and its words fade in from `--space-2` below (C-castbar). A popup at its tallest grows the bar upward, so Cast stays put; a shorter popup grows downward, and Cast eases down with the line rather than jumping. The rig checks the line is above Cast and before it in a short popup, at full height, in add mode and with a cast running, and that Cast stays put at full height.
    - **Owner decisions recorded (§13, round 3):** N5, N6 and L3 are kept as built, and the onboarding's fixed height and its empty space are fine.
91. **Fixes from the independent review of round 3.** Each is checked in the real-extension rig at 100 % and 125 %, light and dark.
    - **The CastBar's line eases open; it no longer snaps.** Call 90 gave the line a block-size transition from 0, but the line is a flex item that clips, so its automatic minimum (`min-block-size: auto`) held it at its words' height: on the first frame it was 16 px tall and only its fade and the gap moved, so at full height the bar's top jumped 16 px over the rooms, and in a shorter popup Cast dropped in one frame. It sets `min-block-size: 0` and now runs 0 to 16 px over about 270 ms. In a shorter popup the first room chosen also brings the picker's "Save these rooms as a set", which arrived at once and dropped Cast by 22 px in one frame; it now opens in place the same way (C-picker), so Cast eases down with the popup (at most about 9 px a frame, sampled in Chromium). The rig samples every frame: the line's height must start below half its full height and pass through at least three steps, and in a short popup Cast's largest one-frame move must be at most 40 % of its whole move (it was half or more before).
    - **The welcome step's disc starts with its title.** The header centred the 48 px disc on its block, and the welcome title wraps in the Card, so the title started 18 px above the disc. The disc now starts with the title on every step (M-wizardstep); the rig checks their tops agree within 1 px on every step and state.
    - **Skip's words sit on the step's text edge, and its ring clears the popup's edge.** A full flush pull put Skip's box 5 px from the popup's edge, so its focus ring touched the window (L3 accepted a ring touching a card's edge, not the window's). Skip now pulls back only by its padding less the Card's inline padding: its words start on the step's text edge, the edge of everything above it, and its box sits 6 px inside the bar's edge with its ring clear of it (L-wizard). This replaces call 90's "Skip's words start where Cast's box does".
    - **The master shares the rows' volume column.** The master above the "{{count}} rooms" fold had no Remove slot, so its Slider ended 40 px past the rows'. Open, it keeps the empty slot (M-groupvol); the compact tile's line still has none. The rig checks the master's Slider starts and ends where the rows' do.
    - **Back is tonal, as Settings is.** Back and the PopupHeader's Settings sit in the same header slot; Back was quiet. It is now a tonal IconButton (L-wizard).
    - **Left open:** the step title's size inside the Card is an owner call (§12, 4). The speakers step still lists rooms as status lines rather than the drawing's room rows. Rooms added together all show Joining… until the slowest answers, because ADD_ROOMS answers once for the batch; per-room progress needs the background to report each room as it joins.

**Owner calls.** Only real decisions; each has a default applied, so none blocks the build.

1. **Desktop scope.** The desktop is read-only plus "Stop all casts": no per-cast Stop and no volume there. Default: as stated.
2. **Stop all casts, confirm or not.** The desktop app asks first (a Dialog); the tray cannot, so it stops at once. Default: keep both. The alternative is no confirm anywhere, matching the popup's Stop.
3. **"Update available" placement.** Closed (call 84): a subtle mark on the PopupHeader's Settings, which opens About.
4. **The onboarding step title's size.** The WizardStep `h2` is `--text-6` (20 px), the popup's page-title size, inside the step's Card; the main popup's card titles are 14 px, and the drawing sets the step title on the ground, outside any card. Default: as built (a step is the page's one heading). The alternatives are the title and subtitle above the Card, as "Casting now" sits above its tile, or a smaller title in the Card.

**Build work, not design gaps:**

- **The voice pass.** About 130 NEW strings across the three annexes still need one voice pass before they go into the locale files, including one onboarding room wording for both apps (§11.12). "Video sync" is settled (call 24).
- **The catalogue, lint config and `scripts/check-ds.ts`** in §10. Phase 0 builds them (§14, Build status); each later phase adds its part.
- **Old R7 sheets still draw retired variants.** The full R7 sheets for Switch, Checkbox, Radio, SegmentedControl, Select, Slider, Clacks, Tooltip, Card, Dialog, Disclosure, EmptyState, NavItem, SectionHeader, StepIndicator, Meter, WizardStep and DescriptionList also draw variants retired in §9: Toggle, filter chips, Card raised, Notice summary, timed Toasts, 18 px icons, the mixed checkbox and the sheet. The design canvas (Design system v1 page) shows each item's v1 look. The catalogue page becomes the full reference, so no redraw is planned.
- **The macOS app icon** still needs a check against Apple's grid.

**Outside the design system:**

- The round 12 Sonos hardware tests ran on the owner's speakers (2026-10-09; member leaves, coordinator leaves with a restart, restore without Play). Bonded sets are re-tested after the owner re-bonds the Sub.
- The desktop needs now-playing metadata wired up before RoomCard can show what plays.
- The `tray.rs` change in §11.10.

## 13. Decision log

Owner decisions only, in order. Rounds 6 to 12 are copied from the round 12 notes.

**Round 6 (visual system)**

- Geist 600 for headings and upper-case badges only, over the system UI stack. Speaker names are body text at 600. Tabular figures, no mono face.
- Live is gradient (b), purple to magenta. Magenta means live and nothing else.
- Mute on is the icon swap alone. Teal is removed.
- Dark status is approach C, "harmonised": a gold warning, and the dark Casting badge is the lilac.
- Radius is 8 px at rest.
- Shapes appear only on hover, focus and press. Focus is the hover shape plus a ring. Selected, on and casting stay calm. Stop never reshapes (amended by §11 call 60: Stop takes the hover, focus and press bevel like every Button).
- WebKit falls back to colour plus the ring.
- Chips take an 8 px bevel.
- The Switch is an 8 px rectangle with a 4 px thumb, and only the thumb reshapes.
- Keep "Casting a very fine silence".
- The logo is mark 1b: idle is the outline, and casting fills it in purple.

**Round 7 (atoms)**

- Containers, fluid type and grids. Each atom is designed first.
- Text inputs take a ring and no bevel. The checkbox and the chip × take a 3 px bevel. Radios stay round.
- A calm selected state: pick, then Cast. GroupVolume is added.
- ActionButton's error tint with "Try again" is confirmed.
- The reserve meter sits behind a diagnostics setting, on the desktop only.
- New strings approved: "Cancel", "Optional", and splitting the stop-failed error into its text and "Try again".
- Floors: macOS 13 and Chrome 125.
- Four CSS rules: colour, `sibling-index()`, `text-box` and layout-shift avoidance.

**Round 8**

- The atoms are approved; assemble them.

**Round 9**

- One scroller.
- Per-speaker volumes are hidden by default.
- Selectable rows need clear affordance.
- Build a design system, and manage long content in the popup.

**Round 10**

- Rethink notices as a whole.
- Explore round 9's selection C.

**Round 11**

- Notices live at their source. The toolbar badge is "!" with no count.
- The old picker "does not scale"; picking must be quick.
- The user needs a way to control the volume, and a cast never starts at max.
- Stop is the square glyph plus "Stop".
- Rooms are added from the "n speakers" fold.

**Round 12**

- Sets live on this device only, with no sync.
- "Start no louder than" is on at 30.
- The start level is the lower of the room's level now and the limit.
- No fade-in.
- Sonos groups follow model (a).
- An added room joins the cast's group.
- The Cast button counts rooms.
- Steer: keep it simple.

**Round 13 (design system v1; this file)**

- "While you were away" shrinks to **one line**.
- **No Undo after Stop.** Undo after removing a room stays.
- **Keep the per-room start slider** before Cast.
- **An old companion only warns and never blocks Cast** ("it might still work"). It is a dismissible banner with a softer lead.
- **The quiet tier is dropped** from the popup.
- Complete and finalise the design system: one canonical taxonomy, every item FINAL, and components built only from the design system (§10).
- The defaults this file applies are listed under §12, "Owner calls".

**Round 3 of the built extension (2026-10-11)**

- **N5, keep:** Last cast may preselect a room that is playing other music, with the warning line.
- **N6, keep:** a room inside a bigger group shows "…" before Cast.
- **The onboarding keeps its fixed height** (the popup's tallest on every step) and the empty space a short step leaves; its layout is what must match the main popup (§11 call 90).
- **L3, keep:** a flush Button's focus ring may touch the card's edge.
- **The CastBar's line sits above Cast in every state** (§11 call 90).

**Standing**

- Shipped builds self-host their fonts. Explorations may use the Google CDN.
- Shapes appear on interaction only.
- Shapes appear on focus and press; hover is colour. A press plays the whole morph to the octagon and back, and nothing scales (§11 call 77).
- Rows that are one pressable control take the octagon on press and focus like every other pressable; only text inputs and containers are exempt (§11 call 88).

## 14. Mapping to `packages/ui` and build order

### What exists today, and what happens to it

| Today (`packages/ui/src`)                | v1                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Button`                                 | **rewritten** as Button (kinds, `danger`, `pressed`, `expanded`, `description`, async states)                                                          |
| `ActionButton` + `hooks/useButtonAction` | **replaced** by Button `onAction`; the hook moves inside Button, with no timers                                                                        |
| `IconButton`                             | **rewritten** (quiet / tonal, sm / md, 1.5rem minimum, `pressed`, required label)                                                                      |
| `ButtonGroup`                            | **replaced** by `Cluster`                                                                                                                              |
| `Alert`                                  | **replaced** by Notice and NoticeLine (no `role=alert`); deleted in Phase 2                                                                            |
| `Card`                                   | **rewritten** (one look; the title moves to SectionHeader)                                                                                             |
| `Disclosure`                             | **rewritten** (always `<details>`, with a summary)                                                                                                     |
| `Input`                                  | **replaced** by TextInput plus Field                                                                                                                   |
| `Speaker/SpeakerMultiSelect`             | **replaced** by RoomPicker plus RoomRow `pick`                                                                                                         |
| `Speaker/SpeakerVolumeRow`               | **replaced** by RoomRow `cast` and StartLevel                                                                                                          |
| `VolumeControl`                          | **replaced** by Slider plus IconButton mute; its debounce and cooldown logic moves into RoomRow and GroupVolume                                        |
| `StatusChip`                             | **replaced** by Badge                                                                                                                                  |
| `ToggleSwitch`                           | **replaced** by Switch                                                                                                                                 |
| `Wizard`, `WizardStep`, `StepIndicator`  | **rewritten** as Wizard, WizardStep and StepIndicator                                                                                                  |
| `theme.css`                              | **replaced** by `layers.css`, generated `tokens.css` and `tokens.ts`, `base.css` (with the theme switch), `motion.css`, `utilities.css` and `theme.ts` |

**New in v1:**

- Atoms: Icon (+ `glyphs.ts`), Artwork, Badge, StatusDot, Clacks, Tooltip, Divider, SectionHeader, NavItem, BrandBlock, Meter, Announcer, Checkbox, Radio, SegmentedControl, Select, Chip.
- Molecules: Field, SettingsRow, ChoiceGroup, CopyField, AddressField, DescriptionList, EmptyState, Toast, RoomRow, StartLevel, MediaHeader, GroupVolume, VideoSync, PageHeader.
- Components: PopupHeader, RoomPicker, CastBar, TabCard, CastTile, NoticeSlot, SetList, SettingsSection, Dialog, RoomCard, Rail.
- Shells: PopupShell, StickyActionBar, OptionsShell, DesktopShell, WizardShell.
- Not React components: ToolbarBadge (`tokens.ts` plus background code) and TrayMenu (native strings).

**App-local components today and their v1 home:**

- Extension: `CurrentTabCard` → TabCard; `ActiveCastsList` → SectionHeader plus CastTile list; `ActiveCastCard` → CastTile; `TransportIcon` → Badge; `Onboarding` and its steps → Wizard in WizardShell; the six options sections → SettingsSections in OptionsShell.
- Desktop: `Sidebar` → Rail; `DeviceCard` and `ListenUrl` → RoomCard and CopyField; `ManualSpeakerForm` → AddressField; `SpeakerNotices` → Notice (section); the views → DesktopShell plus PageHeader; `Onboarding` → Wizard.

### Build order

Steps 1 to 4 of the round 12 build plan (the safety fixes) do not depend on any of this and ship first. The design-system build then replaces that plan's step 8, in five phases. Each phase lands with its catalogue section, screenshots and axe.

**Phase 0: foundations**

- `layers.css`
- the token generator (`tokens.css`, `tokens.ts`, `webkit-fallbacks.css`)
- `base.css` (theme switch, focus, forced colours, reduced motion), `motion.css`, utilities, `Cluster`
- `Icon` + `glyphs.ts`
- `Announcer`
- the catalogue page with Playwright and axe
- the lint rules (§10 rows 1 to 4) and `scripts/check-ds.ts`, as warnings

**Phase 1: atoms**

- Button (retires ActionButton and `useButtonAction`)
- IconButton
- TextInput
- Switch (retires ToggleSwitch)
- Checkbox, Radio, SegmentedControl, Select
- Slider (retires VolumeControl)
- Badge (retires StatusChip)
- StatusDot, Clacks, Artwork, Tooltip, Divider, Chip, SectionHeader, NavItem, BrandBlock, StepIndicator, Meter

**Phase 2: shared molecules**

- Field
- SettingsRow, ChoiceGroup
- CopyField, AddressField
- DescriptionList, Disclosure, EmptyState
- Notice + NoticeLine (retires Alert)
- Toast, WizardStep, PageHeader, Card

**Phase 3: the popup**

- RoomRow, StartLevel, MediaHeader, GroupVolume, VideoSync
- then PopupHeader, RoomPicker, CastBar, TabCard, CastTile, NoticeSlot
- then PopupShell + StickyActionBar (retires SpeakerMultiSelect, SpeakerVolumeRow and the nested scroller)

This phase depends on round 12 build steps 5 (rooms), 7 (add a room) and 9 (sets) for its data.

**Phase 4: settings and the desktop**

- SettingsSection, Dialog, SetList, RoomCard, Rail, Wizard
- OptionsShell, DesktopShell, WizardShell
- ToolbarBadge constants, TrayMenu strings and the idle state

**Phase 5: clean-up**

- Delete the retired exports.
- Switch the lint rules to errors.
- Run the voice pass and land the NEW strings.

### Build status

**Phase 0 (foundations) has landed.** What it put where:

- `src/layers.css`: the layer order. Each entry imports it first: `main.tsx` in the popup, the options page and the desktop, and the catalogue. Every `packages/ui` CSS module, the old ones included, is one `@layer components` block. Every app CSS file is one `@layer app` block (the last twelve moved in the CSS audit pass), so no app file beats a component by accident.
- `scripts/tokens.table.ts` → `scripts/generate-tokens.ts` → `src/tokens.css`, `src/tokens.ts` and `src/webkit-fallbacks.css`. `bun run tokens` writes them and `bun run tokens:check` (also part of `bun run test`) fails when they are stale. Hex from the drawings is written as the shortest OKLCH that maps back to the same hex.
- Tokens the spec implies but does not name, so that no component needs a free value: `--leading-1` to `--leading-8` and `--tracking-1` to `--tracking-8` (T-type), `--layer-hover`, `--layer-focus`, `--layer-press`, `--disabled-ink` and `--disabled-fill` (T-state), `--dur-shape` (the shape morph, 0 under reduced motion), `--dur-change` (a change of state that fades or folds, 0 under reduced motion), `--dur-fade-step` (500 ms, `clack-fade`), `--dur-drift` (8 s), `--live-drift-from` (−16), `--clack-animation`, `--clack-dim` and `--clack-shut` (T-motion), `--live-from`, `--live-to` and `--live-stop-1` to `--live-stop-5` (the live gradient), and `--icon-stroke` (1.75, T-icon). `--brand-ink` has no dark value, as the spec says. `--tracking-2` to `--tracking-4` have no reader yet: nothing sets Geist at 12 to 14 px.
- `src/base.css`: the theme switch (`data-theme` "light" or "dark" on `<html>`; any other value, such as the apps' "auto", follows the system), the focus ring, forced colours, reduced motion (it re-points the motion tokens), prose links and the scrollbar colour. `src/theme.ts` holds `applyTheme()`. `src/motion.css` holds `clack`, `clack-fade` and `drift`. `src/utilities.css` holds `.num`, `.mono` and `.visually-hidden`.
- `src/fonts.css` and `src/fonts/`: Geist 600 (the official v1.7.2 `Geist-SemiBold.woff2`, unmodified) with its OFL, and the two metric-matched fallback faces. Both apps bundle it; nothing uses it until the headings move to `--font-head`, so there is no preload yet.
- `Cluster`, `Icon` (with `glyphs.ts`) and `AnnouncerProvider` / `useAnnouncer`, exported from `@thaumic-cast/ui`.
- The catalogue (`catalogue/`): `bun run --filter @thaumic-cast/ui catalogue` serves it, and `test:catalogue` runs axe in both themes and, with `DS_SCREENSHOTS=1` (set in CI), one screenshot per section. Since the CSS audit pass it runs in a Chromium and a WebKit project, loads `webkit-fallbacks.css`, and has four more sections: the container-query molecules framed at compact (22rem), medium (36rem) and wide (52rem) in both densities, each frame saying when the window squeezes it; the field molecules and a stacking Cluster the same way; the rail in a 40rem and a 52rem window; and the fluid ramp measured at 352, 640 and 960 px with a resizable frame. Playwright's WebKit has `light-dark()`, `corner-shape` and relative colour, so on its own it never draws the floor's fallbacks; `check-ds.ts` holds the rules (no `light-dark()` outside the token files, every above-floor feature behind `@supports`) and the catalogue's floor mode (`?floor=1`, `catalogue/floor.ts`, `tests/floor.pw.ts`) renders and tests them (§11 call 52).
- `bun run lint:ds`: rows 1 to 4 (`stylelint.ds.config.js`, `eslint.ds.config.js`) and row 5 (`scripts/check-ds.ts`) as a report that exits 0. It exits 1 only when a file already built from the design system breaks a rule. Phase 5 turns every rule into an error in `bun run lint`.

**For the apps, Phase 0 adds the layer order, the tokens and the font file, and changes nothing on screen.** They do not load `base.css`, `motion.css` or `utilities.css` yet: those change the focus ring and the theme default, so they arrive with the Phase 1 atoms, which replace `theme.css`.

**Phase 1 (atoms) has landed.** What it put where:

- The 23 atoms of §4, each a folder in `src/` (component, one `@layer components` module, JSDoc) with a catalogue section showing every kind and every §3 state in both themes; hover, focus-visible and press are drawn with a `data-force` attribute that the modules (and `base.css`, for the ring) honour. `src/atoms.test.ts` covers the pure parts; `catalogue/tests/atoms.pw.ts` covers the behaviour in a browser, and `catalogue/tests/press.pw.ts` the shape grammar (hover, focus, the press hold, no size change, reduced motion).
- Retired and deleted: ActionButton, `useButtonAction`, ButtonGroup, Input, ToggleSwitch, VolumeControl (its timing moved to `Speaker/useVolumeControl.ts`) and StatusChip. Alert, Card, Disclosure, Wizard, SpeakerMultiSelect and SpeakerVolumeRow stay until their phases, drawing the new atoms; the Speaker ones are marked deprecated.
- The apps load `base.css`, `motion.css` and `utilities.css`, use `applyTheme`, preload Geist and set `data-density` on `<html>` (popup; desktop for the options page and the desktop app). The extension builds CSS for Chrome 125. Headings are Geist 600 and trimmed (F-textbox). `theme.css` was a bridge of the few old names still read, mapped to the tokens; the CSS audit pass moved its last readers to the tokens and deleted it. Each surface mounts one `AnnouncerProvider`. Apps no longer import `lucide-preact`.
- Every app file was put in `lint:ds`'s clean paths except the layouts Phases 3 and 4 rebuild wholesale: the cast card and its list, the app shells and the onboarding frames. Since Phase 3 only the desktop shell and the two onboarding frames are left out.
- Decisions where this file was silent are in §11, call 36.

**Phase 2 (shared molecules) has landed.** What it put where:

- Field, SettingsRow, ChoiceGroup, CopyField, AddressField, DescriptionList, EmptyState, Notice, NoticeLine, Toast, PageHeader and WizardStep, each a folder in `src/` with a catalogue section in both themes (and both densities where they differ, in compact, medium and wide containers); Disclosure (now always `<details>`) and Card (one look, its heading a SectionHeader) are rebuilt in place. `src/molecules.test.ts` covers the pure parts; `catalogue/tests/molecules.pw.ts` the behaviour.
- Retired and deleted: Alert, the old Disclosure (`hint`, `expanded`) and the old Card (`className`, `icon`, `noPadding`), and the desktop's ManualSpeakerForm. `copyPendingText` moved from the desktop app into CopyField. Button gained `status` (a done held from outside) and an `onClick` that can stop `onAction`; SegmentedControl gained `aria-describedby`.
- The apps: the options page and the desktop views take PageHeader, SettingsRow, ChoiceGroup, AddressField, CopyField and DescriptionList; every Alert is a Notice in its old place, said by the Announcer; success and waiting lines in both onboardings are checklist lines; the empty states are EmptyStates. The popup's cast card, picker and shell, the NoticeSlot placement, the options and desktop shells, the Rail, the Wizard and SettingsSection are left to Phases 3 and 4.
- Decisions where this file was silent are in §11, call 37. Rows are not divided until SettingsSection (Phase 4).

**The size pass (F-size) has landed with Phase 2.** sm is 32 on every surface and the default; md is marked at each call site that is a view's own action (PageHeader actions, the Wizard and its steps' actions and AddressField, the Cast button). IconButton draws 28 / 32 everywhere; Button, IconButton, Chip ×, Switch, Disclosure and the SegmentedControl segments reach `--hit-min` by an `::after`; TextInput and Select by their native element, transparent and centred on the drawn box (it works: a press 6 px outside a 32 field lands in it). CopyField is text plus a quiet Copy. Every Button, IconButton, TextInput, Select and Disclosure carries `data-size`, so the catalogue's check (`catalogue/tests/size.pw.ts`) lists every md instance and fails on a short or overlapping hit area in the mock views. The catalogue's "Size and touch" section (`#size`) is the prototype for the Surface Go 2 tap test; "Show hit areas" in its header (or `?hits=1`) tints every hit area. To open it on another device on the LAN: `bun run --filter @thaumic-cast/ui catalogue:lan`, then `http://<this computer's address>:4180/#size` (from WSL2, mirrored networking or a port proxy to 4180 is needed). The fallback is one token: desktop `--control-sm` 2.25rem in `scripts/tokens.table.ts`.

**Phase 3 (the popup) has landed, speaker-free.** What it put where:

- RoomRow, StartLevel, MediaHeader, GroupVolume, VideoSync, PopupHeader, RoomPicker, CastBar, NoticeSlot, TabCard, CastTile, PopupShell and StickyActionBar, each a folder in `src/` with a catalogue section in both themes, and one section framing them at 22, 36 and 52rem in both densities. `src/components.test.ts` covers the pure parts (the start level's table row by row, the search, the master's mean and the fold's summary); `catalogue/tests/components.pw.ts` and `popup.pw.ts` the behaviour, including the one scroller, the end padding that follows the bar and a Tab walk of a long popup (2.4.11).
- Retired and deleted: the whole `Speaker/` folder (SpeakerMultiSelect, SpeakerVolumeRow; `useVolumeControl` lives in `RoomRow/`), and in the extension `CurrentTabCard`, `ActiveCastsList`, `ActiveCastCard`, `TransportIcon`, the popup grid, the 5-second auto-stop notice and the IP speaker selection. `@thaumic-cast/ui/tokens` exports the tokens on their own, for the service worker's toolbar badge.
- The data under it (round 12 build steps 5, 9 and the speaker-free part of 7): bonded members marked `invisible`, rooms derived in protocol (`roomsOf`, `roomLevel`, `roomAvailability`), sets on this device (`lib/room-sets.ts`, Last cast written when a cast starts), `START_CAST` by room ids, `ADD_ROOMS`, start levels by room, the away log and the toolbar badge.
- The popup (`apps/extension/src/popup`) is PopupShell › PopupHeader › the banner › the away line › "Casting now" with a CastTile per cast › the TabCard › the StickyActionBar (Toast, CastBar). `lib/popup-notices.ts` places the notices and `lib/popup-rooms.ts` holds the rules for sets, the replace hint, cast rows and the master; both are pure and tested. Every popup file is in `lint:ds`'s clean paths.
- Journeys are shot by the screenshot harness (`phase1-shots/harness/shoot-popup.mjs` with `scenarios-popup.mjs`, in the design repository) at 352 px, light and dark, in Chromium and WebKit, and each frame is checked for a second scroller, for scroll padding equal to the bar plus 8 px, and for where focus is (never the page). Its stub can follow Stop, Remove and Undo, so focus after Stop, a removed row and Undo are shot too.
- Decisions where this file was silent, and the interim behaviour until regrouping, are in §11, call 82; the fixes from the independent reviews are call 83. Regrouping, its guarded restore and joining an added room to the cast's Sonos group have landed (call 84); per-room levels inside a bigger group before Cast are still not built.

**Regrouping has landed** (§11 call 84). In `thaumic-core`: the planner (`services/regroup.rs`), the one-at-a-time regroup lock, the fresh grouping read, the guarded restore with `rejoin_group` (no Play), and the call-id echo, all tested against the fake household, so the desktop app and the headless server both have it. In the extension: the cast plan's `leaving` and `restarting`, the CastBar's three sentences, `ADD_ROOMS` by `rooms`, the master over the current group, `roomLevel` `own`, the call id on every playback start, and the older-companion fallback; "Play speakers as one group" is retired. In `packages/ui`: IconButton `mark`, PopupHeader `updateLabel`, and PopupShell without the end row. Per-room levels inside a bigger group before Cast are still "…".

## 15. Drawings

Every item is drawn on the design canvas, Design system v1 page: six index boards (tier 0, the tokens and foundations, to tier 5, the shells and the retired list) and 23 packet boards with the full sheets. Each board passes the canvas checks: format, contrast (0 failures), overflow, accessibility (nothing unnamed, nothing under 24 px, no nested scroller; on every PopupShell frame the scroll padding is the bar plus 8 px) and the Segoe UI Variable and classic Segoe UI font runs. The older round 6 and round 7 sheets that §4 to §6 cite (R6, R7) are on the same canvas.
