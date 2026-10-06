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
- Shapes appear only on hover, focus and press. Selected, on, casting and current stay calm. Stop never reshapes. Containers, text inputs and rows never reshape.
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

**Primitives** are the eight-step ladders, at OKLCH lightness 20, 30, 40, 50, 60, 76, 90 and 95. Components never read a primitive.

| Ladder        | Hue, chroma cap | 20        | 30        | 40        | 50        | 60        | 76        | 90        | 95        |
| ------------- | --------------- | --------- | --------- | --------- | --------- | --------- | --------- | --------- | --------- |
| `--purple-*`  | 305, .2         | `#22003a` | `#41006a` | `#620b9b` | `#7f36bc` | `#9d57de` | `#c896ff` | `#e7d5ff` | `#f3eaff` |
| `--neutral-*` | 308, .03        | `#1a1221` | `#322a3a` | `#4c4454` | `#685f71` | `#857c8e` | `#b6acc0` | `#e3d9ee` | `#f4eaff` |
| `--red-*`     | 27, .2          | `#320001` | `#5d0005` | `#8b000b` | `#bb0916` | `#de3c37` | `#ff8b7f` | `#ffd2cc` | `#ffe9e6` |
| `--magenta-*` | 350, .22        | `#2f001b` | `#570036` | `#820054` | `#b00073` | `#d72f92` | `#ff7fc0` | `#ffcee4` | `#ffe7f1` |

**Semantic tokens** (light / dark):

| Token                                                | Light                     | Dark                                                         | Use                                                                        |
| ---------------------------------------------------- | ------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `--ground`                                           | `#efe8f5`                 | `#0d0913`                                                    | window, popup body; default `--ring-gap`                                   |
| `--surface`                                          | `#fefdff`                 | `#1b1523`                                                    | cards, rows                                                                |
| `--container`                                        | `#e7dcf1`                 | `#292133`                                                    | rail, inset controls, read-only field (light)                              |
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
| `--danger` / `--on-danger`                           | `#c2181d` / `#ffffff`     | `#f97770` / `#3d090a`                                        | filled danger Button; never seeded                                         |
| `--track`                                            | = `--container-high`      | = `--container-high`                                         | Slider, Meter                                                              |

The **status sets** each have a container, an on-container text colour and an ink (light / dark, dark is approach C, "harmonised"). In light, glyphs take the on-container colour; in dark, they take the ink.

| Set     | Light container / text / ink      | Dark container / text / ink       |
| ------- | --------------------------------- | --------------------------------- |
| danger  | `#ffdbd6` / `#76080c` / `#c2181d` | `#442726` / `#ffe8e7` / `#e88382` |
| warning | `#fde1a7` / `#593301` / `#935d00` | `#664700` / `#f7eddc` / `#ffc251` |
| success | `#c6f2cb` / `#11401c` / `#257c3a` | `#18382b` / `#e0f4ea` / `#64d7aa` |
| info    | `#e7dcf1` / `#1b1122` / `#4d4356` | `#233147` / `#e5efff` / `#8db8ff` |

The token names are `--{set}-container`, `--on-{set}-container` and `--{set}-ink`.

Two colour features are not plain tokens:

- **The live gradient.** Light runs from `oklch(42% .2 300)` to `oklch(54% .22 350)`; dark from `oklch(72% .15 300)` to `oklch(78% .15 350)`. Five sRGB fallback stops come first. The drift `--live-shift` runs from −16° to 0° over 8 s and holds under reduced motion. It is used once per screen ("Casting now").
- **The artwork-seeded card.** JS samples the artwork and writes `--art-seed`, clamped, with near-grey seeds swapped for purple-grey. It sets `data-red-guard` for a red seed (hue 20–40, chroma above .1). CSS maps the seed with relative colour:
  - `--np-card`: 92 % / 30 % lightness, chroma capped at .06 / .09
  - `--np-title`: 23 % / 92 %, chroma capped at .06 / .04
  - `--np-rim`: 49 % / 66 %, chroma capped at .14 / .10
  - `--np-sub` and `--np-primary` are mapped the same way.

  Where relative colour is missing (the desktop WebKit floor), the same JS writes `--art-card`, `--art-title` and `--art-rim`.

The audits are in the palette accessibility audit (F-a11y) and in the Badge and StatusDot tables in annex 1 (see the design canvas, Design system v1 page).

### T-state: state and disabled

- `--layer` is registered with `@property` as a `<percentage>`. It is 8 % on hover, 10 % on focus and 12 % on press, mixed as `color-mix(in oklch, var(--layer-ink) var(--layer), var(--control-bg))`.
- **Shape per state:** rest `--radius-control`; hover and focus `--shape-bevel` (or `--shape-bevel-short` on 24–28 px controls, `--shape-bevel-small` on the checkbox and the chip ×); press `--radius-pressed`. Selected, on, current and casting keep the rest shape.
- **Press scale:** `--press-text` .96 (a labelled control), `--press-icon` .92 (an icon-only control), `--press-wide` .98 (a control wider than 15rem: rows, triggers, Select). None under reduced motion.
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

  | Annex value          | Where                             | Token                                                                           |
  | -------------------- | --------------------------------- | ------------------------------------------------------------------------------- |
  | .1875rem (3 px)      | RoomRow block padding             | `--space-1`                                                                     |
  | .5625rem (9 px)      | the artwork band's end padding    | `--space-3-5`, with the rim at `--line-bold` (so the band still lands on 12 px) |
  | 3 px                 | the artwork band rim              | `--line-bold`                                                                   |
  | 5 px                 | the gaps beside the Slider handle | `--space-2`                                                                     |
  | .125rem between rows | picker and pick lists             | `--space-1` (already a step)                                                    |

  The drawings show the band at the snapped values; the other snaps are 1 px and are within drawing tolerance.

### T-shape: radius, shape and line

- **Lines:** `--line-hair` 1px (hairlines, control edges at rest, the bar rule) and `--line-bold` 2px (the focus gap and ring, the open, invalid and current edges, the artwork rim). These are the only px values outside `tokens.css` comments, and borders are the one place stylelint allows them.
- **Radii:**

  | Token                                   | Size    | Use                                            |
  | --------------------------------------- | ------- | ---------------------------------------------- |
  | `--radius-pressed` (= `--radius-thumb`) | .25rem  | press, thumbs, favicon                         |
  | `--radius-control`                      | .5rem   | every control at rest                          |
  | `--radius-group` (= `--radius-notice`)  | .75rem  | segmented track, listbox, notices, popup frame |
  | `--radius-card`                         | 1rem    |                                                |
  | `--radius-dialog`                       | 1.75rem |                                                |
  | `--radius-full`                         |         |                                                |
  | `--radius-thumb-pressed`                | .125rem | the Switch thumb pressed                       |

  Steps 20 and 36 are retired.

- **Bevels** (shape tokens, set with `corner-shape` inside `@supports (corner-shape: bevel)`):

  | Token                 | Size               | Use                               |
  | --------------------- | ------------------ | --------------------------------- |
  | `--shape-bevel`       | .625rem            |                                   |
  | `--shape-bevel-short` | .5rem              | 24–28 px controls                 |
  | `--shape-bevel-thumb` | .3125rem / .375rem |                                   |
  | `--shape-bevel-small` | .1875rem           | checkbox box, chip ×, chip remove |

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

- **Durations:** `--dur-fast` 183ms, `--dur-effects` 268ms, `--dur-spatial` 480ms, and `--dur-step` 120ms (one Clacks step).
- **Timings in script** (`tokens.ts`, not CSS): `TOOLTIP_DELAY_MS` 500, `ANNOUNCE_GAP_MS` 150, `BUSY_MIN_MS` 600 (a busy state shows at least this long, so it never flickers).
- **Easings:** `--ease-effects` is `cubic-bezier(.3, 0, .1, 1)`; `--ease-spatial` is `cubic-bezier(.34, 1.36, .64, 1)`, used for the press release and fold height.
- **Keyframes** live in `packages/ui/src/motion.css`, inside `@layer base`, and nowhere else: `clack`, `clack-fade` and `drift`. Entrances use `@starting-style`.
- **Reduced motion:** shapes swap without morphing, a press darkens without scaling, `drift` holds and `clack` becomes `clack-fade`.

### T-stack: stacking

- Overlays use the top layer, never `z-index`: `<dialog>.showModal()`, `popover="hint"` tooltips, the `base-select` listbox and any menu.
- In flow there are exactly two values:
  - `--z-raised: 1` paints a part over its sibling inside a component whose root sets `isolation: isolate`.
  - `--z-sticky: 2` is for the StickyActionBar (the popup and the options page) and nothing else.

### T-focus: focus ring

- The ring is `box-shadow: 0 0 0 var(--line-bold) var(--ring-gap), 0 0 0 calc(2 * var(--line-bold)) var(--focus)`, and it traces the current corner shape. It is 2 px of `--focus` at 3:1 or more against `--ring-gap` and the control in both themes (WCAG 2.4.13 is AAA and not required; 2.4.7 and 1.4.11 are met).
- Under forced colours it becomes `outline: var(--line-bold) solid Highlight`.
- On macOS, `prefers-contrast: more` raises `--outline-variant` to `--outline`.

### T-target: targets, control heights and sizes

`[data-density]` sets the control heights; container queries never do.

| Token          | Popup   | Desktop and options             |
| -------------- | ------- | ------------------------------- |
| `--control-xs` | 1.75rem | n/a                             |
| `--control-sm` | 2rem    | 2.5rem                          |
| `--control-md` | 2.25rem | 2.75rem                         |
| `--target-min` | 1.5rem  | 2.75rem (an `::after` hit area) |

Neighbouring targets sit at least `--space-3` apart. Every target is at least `--target-min` square (WCAG 2.5.8 needs 24 px; the popup meets it exactly, the desktop at 44).

**T-size: the fixed geometry.** Each item maps its `--{component}-*` sizes to these, and to nothing else. Values marked "density" change with `[data-density]`.

| Token                                                | Value                             | Used by                                                    |
| ---------------------------------------------------- | --------------------------------- | ---------------------------------------------------------- |
| `--size-dot-sm` / `--size-dot-md`                    | .375rem / .5rem                   | StatusDot                                                  |
| `--size-box`                                         | 1.125rem, density 1.25rem         | Checkbox box, Radio                                        |
| `--size-badge`                                       | 1.25rem                           | Badge height                                               |
| `--size-chip`                                        | 2rem                              | Chip height (desktop only)                                 |
| `--size-switch-w` × `--size-switch-h`                | 2.5 × 1.5rem, density 3 × 1.75rem | Switch track                                               |
| `--size-track`                                       | .75rem                            | Slider and Meter track                                     |
| `--size-handle-w` × `--size-handle-h`                | .25rem × 1.75rem                  | Slider handle; its hit box is `--control-md`               |
| `--size-art-md` / `--size-art-lg`                    | 2.5rem / 3rem                     | Artwork (sm is `--icon-sm`)                                |
| `--size-nav`                                         | 3rem                              | NavItem height, and its square in the narrow rail          |
| `--rail-narrow` / `--rail-wide`                      | 4.5rem / 13.5rem                  | Rail                                                       |
| `--popup-inline` / `--popup-block-max`               | 22rem / 37.5rem                   | PopupShell (Chrome's popup limits are 800 × 600)           |
| `--page-max`                                         | 40rem                             | OptionsShell column                                        |
| `--ch-volume` / `--ch-ms` / `--ch-count` / `--ch-ip` | 3ch / 7ch / 2ch / 15ch            | `.num` boxes (F-shift)                                     |
| `--wide-control`                                     | 15rem                             | the SettingsRow `wide` cut-off and `--press-wide` (F-grid) |

### T-icon: icon sizes

- `--icon-sm` is 1rem, `--icon-md` 1.25rem and `--icon-lg` 1.5rem. 18 px is retired.
- The `settings` glyph is drawn as Lucide `sliders-horizontal` ("sliders" in the drawings); there is no separate cog.
- The Badge glyph is `calc(var(--icon-sm) * .75)`.
- Glyphs are Lucide at stroke 1.75, in `currentColor`.

### T-chrome: chrome constants (`tokens.ts`)

Colours drawn by Chrome or the OS, generated from the same table as `tokens.css`:

- **Toolbar badge:** the text is "!", never a count.
  - Warning: `#935d00` / `#ffffff` light, `#ffc251` / `#2b1d00` dark.
  - Danger: `#8c1116` / `#ffffff` light, `#ef5f58` / `#3d090a` dark.
- **Tray icon:** idle and lit, each in light and dark.

The TS shape is in annex 1, T-chrome.

### T-comp: component tokens

- Each component defines one block of `--{component}-*` tokens, inside its own module in `packages/ui`. Every one maps to a T-token.
- Variants change component tokens only. A context restyles a component by re-pointing its tokens; for example, a Notice sets `--btn-fg` to its on-container ink.
- The blocks are listed with each item below, and in full in the annexes.

## 3. Foundations

| Id           | Item                     | Spec                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-layers     | Cascade layers           | `@layer reset, tokens, base, components, app, overrides;` comes first in each entry. Every `packages/ui` module is one `@layer components {}` block, and app CSS is `@layer app`. `!important` appears only in forced-colours and reduced-motion resets.                                                                                                                                                                                                                                                                                       |
| F-pipeline   | Token pipeline and theme | `tokens.css` and `tokens.ts` are generated. A desktop-only `webkit-fallbacks.css` repeats the tokens for engines without `light-dark()`. The theme switch is written **once**, in `packages/ui/src/base.css`: `:root { color-scheme: light dark }`, with `[data-theme="light"\|"dark"]` overriding it. `applyTheme(pref)` lives in `packages/ui/src/theme.ts`.                                                                                                                                                                                 |
| F-fluid      | Fluid type and space     | `clamp(min, base + k·cqi, max)`. The ramp runs from a 400 px to a 960 px container. min and max are in rem.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| F-containers | Containers and density   | compact is under 25rem, medium is 25–45rem, wide is from 45rem. The containers are `app`, `content`, `card`, `row`, `notice`, `field`, `dialog`, `cluster` and `listbox`. State is carried by `data-state`, not by style queries. There is one scroll-state use: the bar hairline.                                                                                                                                                                                                                                                             |
| F-grid       | Grid and subgrid         | Settings rows subgrid their card. The card grid is `repeat(auto-fill, minmax(min(100%, var(--track-card)), 1fr))`. The constants, used inside `packages/ui` only and generated with the tokens: `--track-option` 12rem, `--track-card` 18rem, `--wide-control` 15rem, the IP box `--ch-ip`, and the container breakpoints 20rem (`field`), 25rem and 45rem (written as literals inside `@container` queries, where custom properties cannot go; `check-ds.ts` allows only these three). The popup list does **not** use subgrid.               |
| F-textbox    | `text-box` trim          | `trim-both cap alphabetic` on control labels and headings, at the same outer size.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| F-shift      | Layout-shift rules       | `scrollbar-gutter: stable`, with `scrollbar-color: var(--outline) transparent` set once in `base.css` (the desktop's thin scrollbar). Every label a Button can show sits in one grid cell. Numbers sit in `ch` boxes: `--ch-volume`, `--ch-ms`, `--ch-count`, `--ch-ip`. Artwork keeps `aspect-ratio: 1` over its placeholder. A field error replaces the help in the same slot. The Geist fallback is metric-matched. The notice-area row is retired: notices arrive in flow with `@starting-style`.                                          |
| F-grammar    | Interaction grammar      | rest `--radius-control` · hover `--shape-bevel` and `--layer` 8 % · focus-visible the bevel, 10 % and the ring (T-focus) · active `--radius-pressed`, 12 % and `--press-*` · selected calm · disabled (T-state) · busy (Clacks, `aria-busy` + `aria-disabled`, focus stays, at least `BUSY_MIN_MS`) · error (`--line-bold` `--danger-ink` edge, the `danger` glyph, `aria-describedby`). The per-item matrix is below the table. A row that is one control takes the layer on its corner and never reshapes. WebKit gets colour plus the ring. |
| F-a11y       | Palette accessibility    | AA in both themes, with a non-colour cue on every state. The colour-vision audit is the palette accessibility audit plus the annex 1 tables.                                                                                                                                                                                                                                                                                                                                                                                                   |
| F-icons      | Glyph inventory          | 33 glyphs plus the mark: stop, plus, chevron-down, chevron-start, x, check, copy, refresh, search, external, settings, play, pause, prev, next, volume, volume-off, speaker, cast, music, monitor, server, info, warning, danger, history, bookmark, home, puzzle, shield, sun, moon, contrast. `chevron-start` and `external` mirror under RTL. Annex 1 maps every retired Lucide icon to its replacement.                                                                                                                                    |
| F-mark       | Mark 1b                  | The idle mark is the octagon outline; while casting it is lit, filled in purple, and never magenta. It is used for the app, the tray (a template image on macOS) and the toolbar.                                                                                                                                                                                                                                                                                                                                                              |
| F-utils      | Utilities                | `Cluster` (`gap` from T-space, `justify`, `stack`; it replaces ButtonGroup and ChipSet). `.num` (tabular, in a `--num-ch` box). `.mono` (machine text: `ltr`, isolated, breaks anywhere, body face). `.visually-hidden`. Prose links (inside help or Notice text) are styled once in `base.css`: `--primary`, underlined; a stand-alone link is Button `link`.                                                                                                                                                                                 |
| F-voice      | House voice              | The Discworld layer (round 6): plain first, wry second. Leads are 34 characters or fewer and use no internal nouns. Every NEW string goes through one voice pass before it lands (§12).                                                                                                                                                                                                                                                                                                                                                        |

### State coverage (every interactive item)

"G" means the F-grammar state, as drawn on the design canvas (Design system v1 page). "n/a" means the state cannot happen, for the reason given. Every cell holds in light and dark, and every focus-visible state keeps the ring clear of the StickyActionBar (2.4.11, L-bar).

| Item                              | Rest · hover · focus-visible · active                            | Disabled                                 | Loading                            | Error                                            |
| --------------------------------- | ---------------------------------------------------------------- | ---------------------------------------- | ---------------------------------- | ------------------------------------------------ |
| Button                            | G (danger: no bevel)                                             | G                                        | busy, then done / failed           | failed (danger container, "Try again")           |
| IconButton                        | G; `pressed` swaps the glyph                                     | G                                        | busy (Clacks replaces the glyph)   | n/a: its result is said, or shown by its row     |
| Switch                            | G on the thumb; the ring on the track                            | G                                        | busy ("Launch at login")           | slides back + the row's sentence                 |
| Checkbox                          | G (`--shape-bevel-small`)                                        | G (38 % ring)                            | n/a                                | n/a: no checkbox is validated                    |
| Radio                             | round in every state; layer and ring only                        | G                                        | n/a                                | n/a: a ChoiceGroup always has a value            |
| SegmentedControl                  | G per segment; the ring on the track                             | G                                        | n/a: theme applies at once         | n/a                                              |
| Select                            | G, `--press-wide`; open = `--line-bold` primary edge             | G                                        | busy (Clacks in the trigger)       | `--line-bold` danger edge + Field error          |
| TextInput                         | layer edge on hover; focus `--line-bold` primary; never reshapes | G                                        | n/a (the Button beside it is busy) | invalid                                          |
| Slider                            | hover halo; focus ring on the handle; active narrows the handle  | G (and "Fixed" reads as text)            | n/a (a joining row is inert)       | n/a                                              |
| Chip ×                            | G (`--shape-bevel-small`)                                        | G (while removing)                       | n/a                                | n/a                                              |
| NavItem                           | G; current is calm                                               | G                                        | n/a                                | n/a                                              |
| Disclosure                        | G, `--press-wide`; open is not selected                          | G                                        | n/a                                | n/a                                              |
| ChoiceGroup option                | the layer on the whole option; never reshapes                    | G                                        | n/a                                | n/a                                              |
| RoomRow `pick` / `cast`           | the layer on the row; never reshapes                             | unavailable ("No answer")                | joining ("Joining…", inert)        | did not join / still playing + row line          |
| StartLevel button                 | G                                                                | n/a: hidden for a fixed output ("Fixed") | "…" while unknown                  | n/a                                              |
| MediaHeader disclosure            | G, `--press-wide`                                                | n/a                                      | n/a                                | n/a                                              |
| Notice, NoticeLine, Toast actions | G on their Buttons                                               | n/a                                      | the action busy                    | the action failed                                |
| CopyField                         | G on the Button                                                  | n/a                                      | n/a: the write is instant          | refused: field revealed and selected + info note |
| AddressField                      | G on the Button                                                  | G (option not chosen)                    | testing                            | failed ("Try again"), invalid (P-forms)          |
| SetList row                       | G on Rename and Remove                                           | n/a                                      | n/a                                | empty name ("A set needs a name.")               |
| Dialog                            | G on its Buttons; initial focus on Cancel                        | n/a                                      | the confirm busy                   | the confirm failed                               |

Not interactive, so no states: Badge, StatusDot, Clacks, Icon, Artwork, Tooltip (it follows its trigger), Divider, SectionHeader, BrandBlock, StepIndicator, Meter, Announcer, Card, DescriptionList, EmptyState (its action is a Button), PageHeader.

## 4. Atoms (23)

Each entry gives the API, then kinds and states, sizes, tokens and a11y. The full sheets are in annex 1 (P1) and in the round 7 atom sheets (R7), as amended here; see the design canvas, Design system v1 page.

### A-button · Button: FINAL

- **Absorbs:** ActionButton, SetButton, raw text buttons, the Alert inline action and the "Update available" link.
- **API:**

  ```ts
  kind?: 'filled'|'tonal'|'outline'|'quiet'|'link'; danger?: boolean; size?: 'sm'|'md';
  icon?: GlyphName; trail?: string; pressed?: boolean; expanded?: boolean; description?: string;
  align?: 'center'|'start'; fullWidth?: boolean; onAction?: () => Promise<unknown>;
  labels?: { busy?; done?; failed? }; resetKey?: unknown; href?: string; disabled?: boolean; children: string
  ```

  `expanded` adds a trailing `chevron-down` and `aria-expanded`, for disclosure triggers such as "Add a room". `description` adds a second line under the label, for example "Garden is not answering; Study goes alone." on a set. Both are new in v1 (§11).

- **Named uses:**
  - Stop: tonal `danger`, `stop` glyph, "Stop".
  - Stop all casts: filled `danger`.
  - Add a room: quiet, with `plus` and `expanded`.
  - Sets: quiet, `pressed`, `align="start"`.
  - Update available: link, with `external`.
- **States:** rest, hover, focus-visible, active, pressed (on), disabled, busy, done, failed (danger-container, "Try again").
  - No timers: done and failed hold until the next press or a change of `resetKey`.
  - Stop and Stop all have busy only ("Stopping…").
  - Danger never bevels.
- **Sizes:** height `--control-sm` / `--control-md`; label `--text-3` (popup sm) or `--text-4-fixed`; icon `--icon-sm` in the popup, `--icon-md` on the desktop.
- **Tokens:** `--btn-bg`, `--btn-fg`, `--btn-edge`, `--btn-h`, `--btn-pad`, `--btn-gap`, `--btn-icon`, `--btn-font`, `--btn-radius`, `--btn-on-*`, `--btn-failed-*`, `--btn-hit`.
- **A11y:**
  - A real `<button>`, or `<a href>` for the link kind.
  - The name starts with the visible words.
  - `pressed` is exposed as `aria-pressed`.
  - Results are said through the Announcer.

### A-iconbtn · IconButton: FINAL

- **Absorbs:** Toggle's mute kind. The cast and sync kinds are retired.
- **API:** `glyph, label (required), kind?: 'quiet'|'tonal', size?: 'sm'|'md', pressed?, pressedGlyph?, busy?, disabled?, onPress`.
- **Kinds:**
  - quiet: Dismiss, Close, mute, **Remove** (the `stop` glyph, "Remove {{name}}"), previous, next, Back, resync, Clear search, icon-only Copy.
  - tonal: Settings, Play / Pause.
  - There is no filled kind.
- **States:** rest, hover, focus, active (.92), pressed (glyph swap, no fill), disabled, busy.
- **Sizes:** `--control-xs` / `--control-sm` (sm / md) in the popup, `--control-sm` / `--control-md` on the desktop; the glyph `--icon-sm` / `--icon-md`. The target is never under `--target-min`.
- **Tokens:** `--ib-size`, `--ib-icon`, `--ib-bg`, `--ib-fg`, `--ib-radius`, `--ib-hit`.
- **A11y:**
  - `aria-label` is required.
  - Mute keeps one name, and `aria-pressed` carries its state.
  - On the desktop, the Tooltip shows the name and is `aria-hidden`.

### A-switch · Switch: FINAL

- **API:** `checked onChange label description? size? disabled? busy? error?`.
- **Shape:** a `--radius-control` track, `--size-switch-w` × `--size-switch-h` (density sets it), with a `--radius-pressed` thumb inset by `--space-1`. Only the thumb reshapes (hover `--shape-bevel-thumb`, press `--radius-thumb-pressed`), and the ring goes round the track. Off: `--line-hair` `--outline` edge, thumb `--on-surface-variant`; on: `--primary` track, thumb `--on-primary`; the thumb's position is the cue, never the colour alone.
- **States:** busy covers "Launch at login". On error the switch slides back and the row says "The settings were not saved. Try again."
- **A11y:** `role="switch"`. The whole row is the target.
- **v1 rows:**
  - Options: Sync video, Keep the tab awake, Browser-wide capture, Start no louder than.
  - Desktop: Launch at login, Speaker monitoring, Clock drift correction, Show diagnostics.
  - "Play speakers as one group" is retired.

### A-check · Checkbox: FINAL

- **API:** `checked, onChange, label, size, disabled`. There is no `indeterminate`: nothing in v1 shows a mixed group (audit; §9).
- **Shape:** a `--size-box` box; rest `--radius-pressed`, hover and focus `--shape-bevel-small`, press `--radius-thumb-pressed`. Off is a `--line-bold` `--outline` ring (3:1 or more on every ground, 1.4.11); on is a flat `--primary` fill with the `check` glyph in `--on-primary`.
- **Uses:** inside RoomRow `pick`, where the label is the row. It absorbs CheckRow. Checkbox groups are not built until something needs one.

### A-radio · Radio: FINAL

- **Shape:** round (`--radius-full`) in every state, `--size-box`; off is a `--line-bold` `--outline` ring, on adds a `--primary` dot. Native radios.
- **Behaviour:** one tab stop on the checked option; the arrow keys move and check.
- **Uses:** only inside ChoiceGroup.

### A-segment · SegmentedControl: FINAL

- **API:** `label value onChange size options[2–3] disabled?`.
- **Selected:** `--primary` fill, `--weight-strong` and the `check` glyph (three cues, so never colour alone). The track is `--radius-group`; the ring goes round the track.
- **Use:** Appearance (Auto, Light, Dark). It replaces the theme `<select>`.
- **A11y:** a radiogroup.

### A-select · Select: FINAL

- **API:** `label value options[{value,label,description?}] size error? busy? disabled? onChange`.
- **Build:** `appearance: base-select`. The listbox is a popover with `--shadow-overlay`. The fallback is a native `<select>`.
- **States:** the trigger follows the button grammar (`--press-wide`). Open shows a `--line-bold` `--primary` edge. Error has a `--line-bold` `--danger-ink` edge. Busy shows Clacks (only while a choice is being applied, such as the language reloading).

### A-text · TextInput: FINAL

- **Absorbs:** Input, the raw URL input, FindField and the number / IP input.
- **API:** `kind?: 'text'|'address'|'search', value, onInput, size?, placeholder?, readOnly?, disabled?, invalid?, inputMode?: 'url'|'decimal', onClear?`. There is no `busy`: when a field's value is being tested, only the Button beside it shows busy (AddressField; §9).
- **Kinds:**
  - `address`: `.mono`, `ltr`, no spellcheck.
  - `search`: leading glyph, a "Clear search" IconButton, Esc clears, and the label is visually hidden.
- **States:** rest (`--line-hair` `--outline`), hover (`--line-hair` `--on-surface`), focus (`--line-bold` `--primary` plus the ring), filled, read-only, disabled, invalid (`--line-bold` `--danger-ink` plus `aria-invalid`). It never reshapes.
- **Tokens:** `--input-h`, `--input-bg`, `--input-ro-bg`, `--input-edge`, `--input-edge-w`, `--input-fg`, `--input-hint`, `--input-pad`, `--input-radius`, `--input-font`.

### A-slider · Slider: FINAL

- **API:** `label min max step value format? centre? size onChange`.
- **Geometry:** a `--size-track` track (`--track`, the filled part `--primary`); a `--size-handle-w` × `--size-handle-h` handle in `--primary` with `--space-2` gaps painted in `--ring-gap`. The hit box is `--control-md` tall across the whole track.
- **Uses:** volume (0–100), start level, and trim (±500 ms, centre 0).
- **A11y:** a native `<input type=range>`. `aria-valuetext` reads the formatted value. Page Up and Page Down step ×10. A click anywhere on the track sets the value, so no drag is needed (WCAG 2.5.7). The handle against the track and the ground is 3:1 or more (1.4.11).

### A-chip · Chip: FINAL

- **API:** `<Chip label onRemove removeLabel />`. Input kind only.
- **Size:** `--size-chip` tall on `--radius-control`; the × is an `--icon-lg` square (24 px, so 2.5.8 holds on its own), hover and focus `--shape-bevel-small`, with an `::after` hit area to the desktop `--target-min`.
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
- **Look:** `--size-badge` tall, Geist caps at `--text-1`, the glyph `calc(var(--icon-sm) * .75)`.
- **Rules:** never focusable, never truncated, never magenta, and never colour alone.

### A-dot · StatusDot: FINAL

- **Absorbs:** LiveLamp and the status-dot copies.
- **API:** `state: 'connected'|'checking'|'failed'|'live', size: sm (`--size-dot-sm`) | md (`--size-dot-md`), onFill?` (`onFill` adds a `--line-bold` `--ring-gap` ring, for the live dot on the artwork band).
- **Shapes:** a dot, Clacks, circle-x, the magenta lamp. `off` folds into `failed`.
- **Rules:** always beside words, `aria-hidden`, never animated.

### A-clacks · Clacks: FINAL

- **What:** the only busy indicator. Three open shutters walk the snake path, one step per `--dur-step`. "Answered" lights all eight in `--success-ink`. Under reduced motion it becomes `clack-fade`.
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
- **Rules:** it can be hovered, and Esc hides it. It never holds anything interactive. It replaces `title=` attributes.

### A-divider · Divider: FINAL

- **What:** `--line-hair` of `--divider`, `aria-hidden`. The `inset` prop is retired.
- **Uses:** the StickyActionBar edge (only while content runs under it), between groups inside one Card, and the compact Wizard footer.

### A-heading · SectionHeader: FINAL

- **API:** `kind: 'card'|'live', level, title, meta?, actions?`.
- **Kinds:** `card` heads a Card or SettingsSection (Geist 600 at `--text-5`). `live` is "Casting now", drawn once with the gradient and a solid colour under forced colours. The `page` kind is retired: every page `h1` is a PageHeader (§9).

### A-nav · NavItem: FINAL

- **API:** `icon label href current? disabled?`.
- **Current:** `--primary-container` plus a `--line-bold` `--primary` inset edge, with `aria-current="page"` (fill, edge and weight: never colour alone).
- **Sizes:** `--size-nav` tall; icon-only, `--size-nav` square, with a Tooltip in the narrow rail.

### A-brand · BrandBlock: FINAL

- **What:** mark (lit while casting) plus "Thaumic Cast" in Geist 600 at `--text-6`, and in the wide rail the version line.
- **Collapsed:** `role="img"`.

### A-step · StepIndicator: FINAL

- **Look:** done is filled, current is the pill, to come is a ring.
- **A11y:** `role="progressbar"` named "Step {{n}} of {{m}}: {{label}}".

### A-meter · Meter: FINAL

- **What:** a native `<meter>` for the reserve in ms, value in a `--ch-ms` box, on a `--size-track` track. Normal fill is `--primary`; low shows the `--warning-ink` fill and the `warning` glyph (two cues).
- **Where:** desktop only, with diagnostics on.
- **A11y:** named "{{name}} reserve".

### A-announcer · Announcer: FINAL

- **What:** one polite region and one assertive region per surface: `AnnouncerProvider` plus `useAnnouncer().say(message, { key?, urgent? })`.
- **Rules:**
  - Nothing is said on open.
  - `key` dedupes.
  - Messages are spaced `ANNOUNCE_GAP_MS` apart.
  - `urgent` is used only for S2 (a danger banner after open), S6 (a room's failure) and S8 (a CastBar failure).
  - Components never render `aria-live` or `role="alert"`.

## 5. Molecules (18)

### M-field · Field: FINAL

- **API:** `label help? error? optional? id` around a TextInput, Select or Slider.
- **Behaviour:** the error replaces the help and comes first in `aria-describedby`. Only an optional field is marked ("Optional").

### M-setrow · SettingsRow: FINAL

- **API:** `label help? note? control detail? disabled? locked?`. The control declares `data-width="narrow"|"wide"`; wide means over `--wide-control`.
- **Layouts:** compact `'label control' 'help help' 'note note'`; medium keeps help out of the control column. Wide controls stack at compact and at medium.
- **`detail` slot:** shows only while the row's Switch is on. Its one use is "Start no louder than" with its Slider at 30.
- **States:** locked by an environment variable (`aria-disabled`, note reachable) and error.
- **Rule:** the row never tints.

### M-choice · ChoiceGroup: FINAL

- **API:** `legend legendHidden? value onChange size? options[{value,label,description}] disabled?`.
- **The option is one control:** a label round one radio. It takes the layer, carries the ring and never reshapes. The radio-card frame is retired.
- **Layout:** `--track-option` auto-fit columns with subgrid from 25rem.
- **Uses:** Companion (Find it automatically / Enter the address), Audio quality.

### M-copy · CopyField: FINAL

- **What:** a read-only `address` TextInput plus a tonal Button ("Copy URL" or "Copy address").
- **Behaviour:** `done` ("Copied") holds with no timer. The Announcer says "Copied". When the clipboard refuses, the field is revealed, focused and selected, with an info note.
- **Layout:** under 20rem of its own `field` container (a container-query literal), the action is icon-only, still named "Copy URL" / "Copy address".

### M-address · AddressField: FINAL

- **API:** `kind: 'server'|'speaker', label, value, onChange, action {idle,busy,failed}, onTest, help?, list?, onRemove?, disabled?`.
- **States:** idle, testing (only the Button shows busy), success (server: StatusDot plus "Thaumic Cast answered" plus the latency in a `--ch-ms` box; speaker: the address becomes the last Chip), failed (Button "Try again", no `aria-invalid`), invalid (P-forms).
- **Contexts:**
  - Popup onboarding: server kind, compact, "Connect".
  - Options › Companion: server kind, beside, "Connect".
  - Desktop Settings › Speakers: speaker kind, "Add speaker", with the Chip list.

### M-dl · DescriptionList: FINAL

- **API:** `kind: 'readout'|'stat'|'checklist', rows`.
- **Kinds:**
  - readout: "For the next tab cast".
  - stat: Server, with counts in `--ch-count` boxes and the Address as a CopyField.
  - checklist: StatusDot plus one sentence, for the desktop Ready step.
- **Build:** a real `<dl>` for readout and stat; a `<ul>` for the checklist.

### M-disclosure · Disclosure: FINAL

- **API:** `label summary? open onOpenChange size? disabled?`. Always `<details>` + `<summary>`; the `as="button"` build is retired with the desktop GroupVolume it served (the desktop is read-only; §9).
- **Look:** quiet. The chevron turns (`--dur-effects`), and the summary truncates before the label; the label never truncates.
- **Uses:** the GroupVolume rooms fold, Fine-tune, Advanced, "Enter the address yourself", the Rooms fold.

### M-empty · EmptyState: FINAL

- **API:** `kind: 'empty'|'searching'|'offline', title?, body, action?, link?`.
- **Look:** the idle mark, replaced by Clacks while searching. Under 25rem the art sits beside the words; from 25rem they stack and centre. The dashed border is retired.

### M-notice · Notice: FINAL

- **API:** `kind: 'banner'|'section', tone: 'danger'|'warning'|'info', lead, text?, action?, details?, onDismiss?, also?`.
- **Kinds:** a banner is page level, at most one, and a `role="region"` named by its lead. A section is a `<section>` named by its lead. There is no `role="alert"`. The tone is shown by the container colour, the glyph and the lead's words together (never colour alone).
- **X rule:** a blocking danger notice has no X. Esc never dismisses.
- **Layout:** the action goes under the text below 25rem and beside it from 25rem.

### M-noticeline · NoticeLine: FINAL

- **API:** `tone: 'info'|'warning'|'danger', glyph?, lead, text?, srPrefix?, action?, details?, opensTile?, onDismiss?`. The tone names match Notice (annex 2's `neutral` is `info`).
- **One item per row, five uses:**
  - row line (danger, Try again, X)
  - tile note (info, Details, X)
  - CastBar line (danger, X)
  - slot line (opens the tile, no X)
  - away line (info, the `history` glyph, "{{count}} more", X)
- **Rule:** words wrap and never truncate. Leads are 34 characters or fewer (F-voice), so a line with its trailing parts fits one row at popup width and default text size; at larger text it wraps (1.4.4, 1.4.10).

### M-toast · Toast: FINAL

- **API:** `text action? onAction onDismiss`.
- **Look:** inverse surface, the info glyph, a quiet action, X. It has no tones.
- **Rules:**
  - It lives in flow: in a StickyActionBar (the popup and the options page) or in the desktop's toast row. Never in the top layer, so it takes no shadow.
  - One at a time, never on a timer. It goes on the next action, Esc, X or leaving.
  - Undo follows a removal only: a room from a cast (popup), or a set (options › Sets). Never after Stop (P-stop).
- **A11y:** the Announcer says it, and it never takes focus.

### M-roomrow · RoomRow: FINAL

One row per room. It absorbs SpeakerRow, SpeakerVolumeRow, SpeakerMultiSelect's rows, CheckRow and the speaker list items.

- **`pick`:** the `<label>` is the checkbox. The sub line holds "Grouped with …", a Badge and "at 72 now". StartLevel sits outside the label. The row is unavailable when the room does not answer.
- **`cast`:** name plus Badge; mute, Slider, value (`--ch-volume`) and Remove. "Joining…" makes the row inert. A failure adds a row line with Try again. The last room has no Remove (Stop ends the cast).
- **`list`:** read-only, with a disc Artwork, the name, a sub line and a Badge.

### M-startlevel · StartLevel: FINAL

- **What:** LevelButton (the number and a chevron, `aria-expanded`) opens StartLine: a Slider with a ghost tick at the current level, a `--ch-volume` value and a caption.
- **Text forms:** "…" while the level is unknown; "Fixed" for a fixed output.
- **Rule:** the level is pending, and nothing is sent before Cast.

### M-media · MediaHeader: FINAL

- **API:** `kind: 'tab'|'browser', art?, title, subtitle, playing, size, disclosure?, transport?, onGoToTab?, trailing?`.
- **Kinds:** `browser` reads "Whole browser" / "Browser-wide capture" with a monitor disc, and has no transport.
- **Open tile:** it sits on the artwork band; the red guard moves Stop off the band.
- **Desktop:** read-only.

### M-groupvol · GroupVolume: FINAL

- **One room:** its volume line plus "Add a room".
- **Two or more rooms:** a master (the Sonos group volume, showing the mean) plus the "{{count}} rooms" fold, whose summary lists the levels. Then the rows, then "Add a room" last, which opens the add list.
- **Memory:** open or shut is remembered for the popup session.

### M-videosync · VideoSync: FINAL

- **What:** a SettingsRow ("Sync video" + Badge + Switch, one name) plus the "Fine-tune" Disclosure (trim Slider, `--ch-ms` value, resync IconButton).
- **States:** Waiting, Measuring…, In step, Out of step.

### M-wizardstep · WizardStep: FINAL

- **What:** a disc Artwork plus the step's `h2` plus a subtitle plus a body slot.
- **Focus:** moves to the `h2` on a step change.

### M-pageheader · PageHeader: FINAL

- **What:** an `h1` at `--text-8` plus an optional summary ("4 rooms, 2 casting") plus optional actions in a Cluster. It is every page title: the desktop views, Not found and the options page ("Settings", no summary, no actions).

## 6. Components (15)

| Id            | Component              | Built from                                                                                                                                                           | Key rules                                                                                                                                                                                                                                                                                                                   |
| ------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-popupheader | **PopupHeader**        | BrandBlock, StatusDot plus words, Settings IconButton                                                                                                                | It scrolls away. It never shows a count. States: connected (desktop app or server), casting (lit mark), checking, reconnecting ("Asking the companion again…"), not connected. A status change is said once.                                                                                                                |
| C-picker      | **RoomPicker**         | fieldset "Cast to", set Buttons (`pressed`, `trail` for "Last cast" / "Saved" / the room count), Divider, RoomRow `pick`, Disclosure, TextInput `search`, EmptyState | Sets are Last cast, saved sets, and "Everywhere" from 3 rooms. The rooms fold from 8 rooms, and search lives inside the fold; it never unticks a room and it counts hidden chosen rooms in one line of text under the list. "Save these rooms as a set" opens an inline form. When not connected, the fieldset is disabled. |
| C-castbar     | **CastBar**            | filled Button, the polite line, NoticeLine on failure                                                                                                                | "Cast to {{count}} rooms". The line says at most the leaves-group sentence plus the replace hint. Add mode is Cancel plus "Add {{count}} rooms".                                                                                                                                                                            |
| C-tabcard     | **TabCard**            | Card, MediaHeader (`tab` or `browser`), RoomPicker                                                                                                                   | Shown only while this tab is not casting.                                                                                                                                                                                                                                                                                   |
| C-casttile    | **CastTile**           | Card, MediaHeader, Stop Button, GroupVolume, NoticeSlot, VideoSync                                                                                                   | Compact or open in place. The head row is the same element in both forms. This tab's cast is open. A single cast has no chevron.                                                                                                                                                                                            |
| C-noticeslot  | **NoticeSlot**         | Notice (section), NoticeLine                                                                                                                                         | The first item is drawn in full and the rest are lines. On a compact tile it is one slot line. Order: may cut out soon, cut out, capture health, gaps, drift (≤ 10 min). No quiet-tier lines.                                                                                                                               |
| C-setlist     | **SetList**            | rows (name, "{{count}} rooms", Rename and Remove as quiet Buttons), inline TextInput, EmptyState, Toast                                                              | Rename in place; an empty name is an error. Remove takes effect at once and the Toast offers Undo. Last cast and Everywhere are not listed.                                                                                                                                                                                 |
| C-section     | **SettingsSection**    | Card, SectionHeader, SettingsRows on one subgrid, Dividers                                                                                                           |                                                                                                                                                                                                                                                                                                                             |
| C-card        | **Card**               |                                                                                                                                                                      | One look: `--radius-card`, `--surface`, a `--line-hair` `--outline-variant` edge in light only. No raised kind; `interactive` is not built until needed.                                                                                                                                                                    |
| C-dialog      | **Dialog**             | `<dialog>`, IconButton Close, Cluster `stack`                                                                                                                        | One kind: the modal confirm, for Stop all casts and Disconnect extensions (the sheet kind is retired; nothing uses it). `--radius-dialog`, `--surface`, `--shadow-overlay`, `--scrim`. Initial focus is on Cancel; Esc and Close cancel; focus returns to the opener. Actions stack under 25rem.                            |
| C-roomcard    | **RoomCard** (desktop) | Card, name, Badge, sub line, MediaHeader (read-only), CopyField "Cast URL", Meter                                                                                    | Read-only: no Stop and no volume. Cast URL is revealed when the clipboard refuses. Cards sort casting first.                                                                                                                                                                                                                |
| C-rail        | **Rail**               | BrandBlock, NavItems                                                                                                                                                 | `--rail-narrow` below a 45rem window, `--rail-wide` from it.                                                                                                                                                                                                                                                                |
| C-wizard      | **Wizard**             | WizardStep, StepIndicator, Back IconButton, Skip, Carry on                                                                                                           | Compact form in the popup; full form on the desktop (Back as an outline Button).                                                                                                                                                                                                                                            |
| C-badge-tb    | **ToolbarBadge**       | T-chrome                                                                                                                                                             | Shows "!" with the title "Thaumic Cast: {{lead}}", never a count. Nearly cut out and drift over 10 min never set it.                                                                                                                                                                                                        |
| C-tray        | **TrayMenu** (native)  |                                                                                                                                                                      | Order: version (disabled), status (disabled), —, Open Thaumic Cast, —, Launch at login (check item), —, Stop all casts (disabled while idle; no confirm), Restart Thaumic Cast, —, Quit. Idle and lit icon. Tooltip "Thaumic Cast" and the stop-all variants.                                                               |

The API of each popup component is in annex 2 §11–16. SetList, RoomCard and TrayMenu are in annex 3.

## 7. Patterns (13)

| Id          | Pattern                | The rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P-notices   | Notices at the source  | Placement, suppression ("a bigger problem hides what it explains"), order, dedupe and auto-clear. Toasts are never timed. Screen readers hear nothing on open. The quiet tier is removed: `head_start_close` and drift over 10 min show **nowhere** in the popup; on the desktop they appear only through the Meter with diagnostics on. Replacement text for the round 11 notices spec §2.3, §4, §6 and §11 is in annex 2.                                                                                                                      |
| P-companion | An old companion warns | A warning banner, dismissible per build: "This companion is older than the extension" / "It is on v{{appVersion}}, and it may still work. If anything misbehaves, update it." plus Update. **Cast stays enabled.** "Update available" stays in the end row (popup) and in About (options). It ranks last for the banner.                                                                                                                                                                                                                         |
| P-away      | While you were away    | One neutral NoticeLine with the `history` glyph, first after the header and the banner, once per open. It shows the newest lead; "{{count}} more" (or "Details" for one event) opens the list in place; X dismisses it. Its spoken name is "While you were away: {{lead}}". Storage: `chrome.storage.session`, the last 10 events, none older than 24 h, each shown once.                                                                                                                                                                        |
| P-start     | Start level            | start = min(the room now, the limit). The limit, "Start no louder than", is on at 30. Nothing is remembered. A level set by hand wins for this cast only, with no warning. "…" while unknown (if it still cannot be read at Cast, the room starts at the limit). "Fixed" for a fixed output. The row-text table in annex 2 §4 supersedes `r12/start-level.md`.                                                                                                                                                                                   |
| P-picker    | Picker model B         | Sets, then rooms. The rooms fold from 8. Search only inside the fold. Sets live on this device and are never synced.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| P-addroom   | Add a room             | "Add a room" opens the add list; CastBar add mode commits. The room joins the cast's Sonos group at min(now, limit). The row says "Joining…"; on failure, a row line offers Try again.                                                                                                                                                                                                                                                                                                                                                           |
| P-stop      | Stop, Remove, Undo     | Stop is tonal danger plus the square plus "Stop", named "Stop casting {{title}}". Stop all casts is filled danger plus a confirm. Remove is a quiet IconButton with the square. **No Undo after Stop**: the Announcer says "Cast to {{name}} stopped." and focus moves to the next tile's Stop, or to the TabCard's heading. Undo after removing a room stays (and after removing a set in Settings). "Cast again" is not in v1. Stop all casts confirms in the desktop app (a Dialog) and not in the tray (a native menu cannot host one; §12). |
| P-x         | The X rule             | X appears only when dismissing has no consequence and the fact lives on elsewhere.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| P-fold      | Fold in place          | Long content folds in place. Nothing in the popup sets its own scroller.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| P-states    | Empty, loading, error  | EmptyState, Clacks with words, "Loading settings…", "The settings were not saved. Try again.", "Speakers are listed here once the companion answers." Loading text is plain text in the slot with `aria-busy` on its container, never a live region. The popup paints nothing until its stored state is read (one storage read, no spinner), then the PopupHeader in `checking` and RoomPicker `loading`.                                                                                                                                        |
| P-copy      | Copy feedback          | The write starts inside the click. `done` holds. The Announcer says "Copied". A refusal reveals and selects the field. There are no timers.                                                                                                                                                                                                                                                                                                                                                                                                      |
| P-forms     | Form validation        | An error shows on blur or submit and clears as soon as the value is valid. On submit, focus goes to the first invalid field. The error is a `--line-bold` `--danger-ink` edge plus the `danger` glyph plus the message, with `aria-invalid`, and is not a live region. A failed request is not a validation error.                                                                                                                                                                                                                               |
| P-diag      | Diagnostics            | A desktop setting, "Show diagnostics", off by default. It needs speaker monitoring and shows the reserve Meter on RoomCards.                                                                                                                                                                                                                                                                                                                                                                                                                     |

The Sonos group model (one group per cast, guarded restore) is product behaviour, not design-system behaviour. It lives in the round 12 Sonos groups note, and its five hardware tests must run before it ships.

## 8. Layouts and shells (5)

| Id        | Shell               | Structure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L-popup   | **PopupShell**      | The document is the one scroller: `inline-size: var(--popup-inline)`, `max-block-size: var(--popup-block-max)`, `scrollbar-gutter: stable`, padding and gap `--space-4`. The order is PopupHeader › banner (0–1) › away line (0–1) › content › StickyActionBar › end row (only while "Update available"). There is no footer and no version line (the version is in Settings › About). Scroll padding is `calc(var(--overlay-end) + var(--space-3))` (WCAG 2.4.11, checked on every frame). It replaces the round 7 CSS notes §5 and §9. |
| L-bar     | **StickyActionBar** | `position: sticky; inset-block-end: 0; z-index: var(--z-sticky)` on `--surface`, padding `--space-3` block. The `--line-hair` `--divider` hairline shows only while content runs under it. It publishes its block size as `--overlay-end`, and its scroller sets `scroll-padding-block-end: calc(var(--overlay-end) + var(--space-3))`. Two homes: the popup (the Toast, then the CastBar or the Wizard's Skip and Carry on) and the options page (the Toast only; 0 tall while there is none).                                          |
| L-page    | **OptionsShell**    | One column, `max-inline-size: var(--page-max)`, `data-density="desktop"`, PageHeader "Settings". SettingsSections sit `--space-5` apart. No status header and no footer. A StickyActionBar at the end holds the Toast, so a focused control is never under it (2.4.11). Every control saves on change. The Language section is hidden while there is one language (as on the desktop).                                                                                                                                                   |
| L-desktop | **DesktopShell**    | Rail plus main (container `content`, the one scroller) plus PageHeader. The toast row sits under main, outside the scroller, and is 0 tall until a toast opens it, so it never covers focus. Window 840 × 640 by default (a Tauri setting, not CSS). Views: Speakers (RoomCards), Server (DescriptionList `stat` + SettingsRows with Button controls), Settings (SettingsSections), Not found (EmptyState "There is no page here" + Button `href` "Back to Speakers").                                                                   |
| L-wizard  | **WizardShell**     | Compact: PopupShell without the header, with Skip and Carry on in the bar. Full: DesktopShell without the Rail.                                                                                                                                                                                                                                                                                                                                                                                                                          |

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
  - the two copy-label timers
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
  - the "Play speakers as one group" setting
  - picker models A and C
  - the "All" slider
  - one row per Sonos group
  - the start sentence in the bar
  - the warning on a start level raised by hand
  - the popup's version line (the round 12 drawings still show "Version 0.12.0" at the foot; the version lives in Settings › About)
  - the options page's sticky toast row as a separate thing (it is a StickyActionBar)
  - the options page's Language row while there is one language, and its hint "English only, so far." (`language_coming_soon`)
- **Strings:** `unmute_speaker`, `sync_speakers_enable`, `sync_speakers_description`, `version_mismatch_message`, `version_mismatch_unknown_message`, `cast_to_n_speakers_*`, `video_sync_toggle`, `error_speaker_stop_failed` (in the popup), `onboarding.speakers.found_*` (popup), `settings.remove_speaker`, `device.coordinator`, `device.others_*`, `transport.playing`, `speakers.summary_speakers_*`, `onboarding.ready.summary_speakers_*`. The full retired lists are in the annexes.

## 10. Only the design system: the rules and how they are enforced

### Apps may use

1. Tokens through `var(--…)`, for every colour, space, size, line, radius, shadow, font, weight, duration, ease and z value, alone or inside `calc()`.
2. Foundations by name: `.num`, `.mono`, `.visually-hidden`, `Cluster`, and the shared keyframes (`animation-name` only). Responsive layout lives in the shells and components; apps write no `@container` or `@media` rules.
3. Design-system components, imported from `@thaumic-cast/ui` only.
4. Literals that are not design values: `0`, `100%`, `auto`, `1fr`, `min-content`, `max-content`, `currentColor`, `transparent`, `inherit`, `none`. Type (size, weight, family, line height, tracking) and z come from tokens only.

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

| #   | Check                                               | Tool and rule                                                                                                                                                                                                                                                                                                                                        | Scope                                                                            |
| --- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | Values come from tokens                             | stylelint `declaration-property-value-allowed-list` (built-in): the value properties may hold only `var(--…)`, `calc()` over `var()`, and the "may use" literals                                                                                                                                                                                     | `apps/**/*.css`, and `packages/ui/src/**/*.css` except the three raw-value files |
| 2   | No raw colour, no units, no local motion or queries | `function-disallowed-list` adds `oklch` and `color-mix`; `unit-disallowed-list: [px, rem, em, ch, ms, s, deg]`; `at-rule-disallowed-list: [keyframes, container, media]`; `declaration-no-important`; `property-disallowed-list: [transition, animation]` (longhands only)                                                                           | `apps/**/*.css`                                                                  |
| 3   | Logical properties                                  | `csstools/use-logical` (in place)                                                                                                                                                                                                                                                                                                                    | all CSS                                                                          |
| 4   | Imports and raw controls                            | eslint `no-restricted-imports` (`@thaumic-cast/ui/src/*`, `lucide-preact`) and `no-restricted-syntax` (lower-case `button`, `input`, `select`, `textarea`, `dialog` elements; `role="alert"`; `aria-live`; a `style` object with a key that is not `--*`)                                                                                            | `apps/**/*.tsx`                                                                  |
| 5   | The token graph                                     | `scripts/check-ds.ts`, run by `bun run lint:ds` (by `bun run lint` from Phase 5): every `var(--x)` is defined in `tokens.css` or a component block; every `--{component}-*` maps to a T-token; tokens defined and never used are listed; `glyphs.ts` holds exactly the F-icons list; every `packages/ui` CSS module is one `@layer components` block | repo                                                                             |
| 6   | Every item, every state                             | `packages/ui/catalogue/` (a Vite page, no Storybook) renders every item in every kind and the states in §3's matrix, light and dark, both densities; Playwright takes its screenshots (baselines made in the CI Linux image only) and `@axe-core/playwright` checks it in the same run                                                               | `packages/ui` changes, CI                                                        |
| 7   | What lint cannot see                                | review: an app component draws no control and no container; a new look goes into `packages/ui` first                                                                                                                                                                                                                                                 | PRs touching `apps/**`                                                           |

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
        ['/^((var\\(--[\\w-]+\\)|calc\\([^;]*\\)|0|100%|auto|1fr|min-content|max-content|none|inherit)\\s*)+$/'],
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
24. **Settled design calls that were listed as owner calls:** Play and Pause are tonal; the fluid ramp tops out at 960; the popup list does not use subgrid; the popup header scrolls away; there is no "Cast again" (the CastBar is the retry); the room failure line keeps its X and wraps; the away line shows the lead, with the sentence as its spoken name (this is what "one line" means at 325 px); the options sections keep "Companion" and "Finer points"; "Sync video" and the onboarding room wording go to the voice pass.

## 12. Still open

**Owner calls.** Only real decisions; each has a default applied, so none blocks the build.

1. **Desktop scope.** The desktop is read-only plus "Stop all casts": no per-cast Stop and no volume there. Default: as stated.
2. **Stop all casts, confirm or not.** The desktop app asks first (a Dialog); the tray cannot, so it stops at once. Default: keep both. The alternative is no confirm anywhere, matching the popup's Stop.
3. **"Update available" placement.** It sits in the popup's end row, under the bar, so on a long popup it is below the fold. Default: the end row. The alternative is a second line in the PopupHeader status.

**Build work, not design gaps:**

- **The voice pass.** About 130 NEW strings across the three annexes still need one voice pass before they go into the locale files, including "Sync video" and one onboarding room wording for both apps (§11.12).
- **The catalogue, lint config and `scripts/check-ds.ts`** in §10. Phase 0 builds them (§14, Build status); each later phase adds its part.
- **Old R7 sheets still draw retired variants.** The full R7 sheets for Switch, Checkbox, Radio, SegmentedControl, Select, Slider, Clacks, Tooltip, Card, Dialog, Disclosure, EmptyState, NavItem, SectionHeader, StepIndicator, Meter, WizardStep and DescriptionList also draw variants retired in §9: Toggle, filter chips, Card raised, Notice summary, timed Toasts, 18 px icons, the mixed checkbox and the sheet. The design canvas (Design system v1 page) shows each item's v1 look. The catalogue page becomes the full reference, so no redraw is planned.
- **The macOS app icon** still needs a check against Apple's grid.

**Outside the design system:**

- The five Sonos hardware tests in the round 12 Sonos groups note (§5) must run before the group change ships.
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
- Shapes appear only on hover, focus and press. Focus is the hover shape plus a ring. Selected, on and casting stay calm. Stop never reshapes.
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

**Standing**

- Shipped builds self-host their fonts. Explorations may use the Google CDN.
- Shapes appear on interaction only.

## 14. Mapping to `packages/ui` and build order

### What exists today, and what happens to it

| Today (`packages/ui/src`)                | v1                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Button`                                 | **rewritten** as Button (kinds, `danger`, `pressed`, `expanded`, `description`, async states)                                                          |
| `ActionButton` + `hooks/useButtonAction` | **replaced** by Button `onAction`; the hook moves inside Button, with no timers                                                                        |
| `IconButton`                             | **rewritten** (quiet / tonal, sm / md, 1.5rem minimum, `pressed`, required label)                                                                      |
| `ButtonGroup`                            | **replaced** by `Cluster`                                                                                                                              |
| `Alert`                                  | **replaced** by Notice and NoticeLine (no `role=alert`)                                                                                                |
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

- `src/layers.css`: the layer order. Each entry imports it first: `main.tsx` in the popup, the options page and the desktop, and the catalogue. Every `packages/ui` CSS module, the old ones included, is one `@layer components` block. App CSS is not yet in `@layer app`; it stays unlayered, so it still beats the components, until the phases that rebuild each screen move it.
- `scripts/tokens.table.ts` → `scripts/generate-tokens.ts` → `src/tokens.css`, `src/tokens.ts` and `src/webkit-fallbacks.css`. `bun run tokens` writes them and `bun run tokens:check` (also part of `bun run test`) fails when they are stale. Hex from the drawings is written as the shortest OKLCH that maps back to the same hex.
- Tokens the spec implies but does not name, so that no component needs a free value: `--leading-1` to `--leading-8` and `--tracking-1` to `--tracking-8` (T-type), `--layer-hover`, `--layer-focus`, `--layer-press`, `--disabled-ink` and `--disabled-fill` (T-state), `--dur-shape` (the shape morph, 0 under reduced motion), `--dur-fade-step` (500 ms, `clack-fade`), `--dur-drift` (8 s), `--live-drift-from` (−16), `--clack-animation` and `--clack-dim` (T-motion), `--live-from`, `--live-to` and `--live-stop-1` to `--live-stop-5` (the live gradient), and `--icon-stroke` (1.75, T-icon). `--brand-ink` has no dark value, as the spec says.
- `src/base.css`: the theme switch (`data-theme` "light" or "dark" on `<html>`; any other value, such as the apps' "auto", follows the system), the focus ring, forced colours, reduced motion (it re-points the motion tokens), prose links and the scrollbar colour. `src/theme.ts` holds `applyTheme()`. `src/motion.css` holds `clack`, `clack-fade` and `drift`. `src/utilities.css` holds `.num`, `.mono` and `.visually-hidden`.
- `src/fonts.css` and `src/fonts/`: Geist 600 (the official v1.7.2 `Geist-SemiBold.woff2`, unmodified) with its OFL, and the two metric-matched fallback faces. Both apps bundle it; nothing uses it until the headings move to `--font-head`, so there is no preload yet.
- `Cluster`, `Icon` (with `glyphs.ts`) and `AnnouncerProvider` / `useAnnouncer`, exported from `@thaumic-cast/ui`.
- The catalogue (`catalogue/`): `bun run --filter @thaumic-cast/ui catalogue` serves it, and `test:catalogue` runs axe in both themes and, with `DS_SCREENSHOTS=1` (set in CI), one screenshot per section.
- `bun run lint:ds`: rows 1 to 4 (`stylelint.ds.config.js`, `eslint.ds.config.js`) and row 5 (`scripts/check-ds.ts`) as a report that exits 0. It exits 1 only when a file already built from the design system breaks a rule. Phase 5 turns every rule into an error in `bun run lint`.

**For the apps, Phase 0 adds the layer order, the tokens and the font file, and changes nothing on screen.** They do not load `base.css`, `motion.css` or `utilities.css` yet: those change the focus ring and the theme default, so they arrive with the Phase 1 atoms, which replace `theme.css`.

## 15. Drawings

Every item is drawn on the design canvas, Design system v1 page: six index boards (tier 0, the tokens and foundations, to tier 5, the shells and the retired list) and 23 packet boards with the full sheets. Each board passes the canvas checks: format, contrast (0 failures), overflow, accessibility (nothing unnamed, nothing under 24 px, no nested scroller; on every PopupShell frame the scroll padding is the bar plus 8 px) and the Segoe UI Variable and classic Segoe UI font runs. The older round 6 and round 7 sheets that §4 to §6 cite (R6, R7) are on the same canvas.
