/**
 * The design system's token table: the one place token values are written.
 *
 * `generate-tokens.ts` turns it into `src/tokens.css`, `src/tokens.ts` and
 * `src/webkit-fallbacks.css`. The values are the ones the design-system drawings were made
 * with (DESIGN.md §2). Colours are written as the drawings' hex and emitted as OKLCH that
 * maps back to the same hex.
 */

/** A colour as hex (`#rrggbb`), or a reference to another token (`var(--name)`), or raw CSS. */
export type ColorValue = string;

/** A token whose value differs between the light and the dark theme. */
export interface ThemedToken {
  /** The light-theme value. */
  light: ColorValue;
  /** The dark-theme value. */
  dark: ColorValue;
}

/** One token: a plain CSS value, or a light/dark pair. */
export type TokenValue = string | ThemedToken;

/** A named group of tokens, emitted together under a comment. */
export interface TokenGroup {
  /** The DESIGN.md section the group comes from, used as the CSS comment. */
  title: string;
  /** Token name (without the leading `--`) to value. */
  tokens: Record<string, TokenValue>;
}

/** A token whose value changes with `[data-density]`. */
export interface DensityToken {
  /** The popup value (the default when no density is set). */
  popup: string;
  /** The desktop and options value (`[data-density='desktop']`). */
  desktop: string;
}

/** The OKLCH lightness stops of the primitive ladders (DESIGN.md T-colour). */
export const LADDER_STOPS = [20, 30, 40, 50, 60, 76, 90, 95] as const;

/** The primitive ladders: hex per stop, as drawn. Components never read these. */
export const LADDERS: Record<string, readonly string[]> = {
  purple: ['#22003a', '#41006a', '#620b9b', '#7f36bc', '#9d57de', '#c896ff', '#e7d5ff', '#f3eaff'],
  neutral: ['#1a1221', '#322a3a', '#4c4454', '#685f71', '#857c8e', '#b6acc0', '#e3d9ee', '#f4eaff'],
  red: ['#320001', '#5d0005', '#8b000b', '#bb0916', '#de3c37', '#ff8b7f', '#ffd2cc', '#ffe9e6'],
  magenta: ['#2f001b', '#570036', '#820054', '#b00073', '#d72f92', '#ff7fc0', '#ffcee4', '#ffe7f1'],
};

const pair = (light: string, dark: string): ThemedToken => ({ light, dark });

/** Semantic colour tokens (DESIGN.md T-colour). */
export const SEMANTIC_COLORS: TokenGroup = {
  title: 'T-colour: semantic',
  tokens: {
    ground: pair('#efe8f5', '#0d0913'),
    surface: pair('#fefdff', '#1b1523'),
    container: pair('#e7dcf1', '#292133'),
    'container-high': pair('#dfd1eb', '#362c42'),
    'on-surface': pair('#1b1122', '#f0edf5'),
    'on-surface-variant': pair('#4d4356', '#c2b9ce'),
    outline: pair('#6e6476', '#91879e'),
    'outline-variant': pair('#cec1d9', '#473d54'),
    divider: pair('var(--outline-variant)', 'var(--container-high)'),
    'inverse-surface': 'var(--on-surface)',
    'on-inverse-surface': 'var(--surface)',
    scrim: pair('oklch(48% 0.03 310 / 60%)', 'oklch(8% 0.02 302 / 70%)'),
    primary: pair('#6d20a8', '#c699f8'),
    'on-primary': pair('#ffffff', '#2b0c44'),
    'primary-container': pair('#e7d5ff', '#4b1d6b'),
    'on-primary-container': pair('#4b1d6b', '#ecddff'),
    'secondary-container': pair('#e8def6', '#382d45'),
    'on-secondary-container': pair('#352546', '#e9e0f5'),
    /* Light only: in dark, headings use --on-surface and the mark uses --primary. */
    'brand-ink': '#4b1d6b',
    focus: pair('#4b1d6b', '#dec3ff'),
    'ring-gap': 'var(--ground)',
    'cast-badge': pair('#e7d5ff', '#c699f8'),
    'on-cast-badge': pair('#4b1d6b', '#2b0c44'),
    'live-lamp': pair('#d72f92', '#ea4ca4'),
    danger: pair('#c2181d', '#f97770'),
    'on-danger': pair('#ffffff', '#3d090a'),
    track: 'var(--container-high)',
  },
};

/** The status sets: container, on-container text and ink (DESIGN.md T-colour). */
export const STATUS_SETS: Record<
  string,
  { container: ThemedToken; on: ThemedToken; ink: ThemedToken }
> = {
  danger: {
    container: pair('#ffdbd6', '#442726'),
    on: pair('#76080c', '#ffe8e7'),
    ink: pair('#c2181d', '#e88382'),
  },
  warning: {
    container: pair('#fde1a7', '#664700'),
    on: pair('#593301', '#f7eddc'),
    ink: pair('#935d00', '#ffc251'),
  },
  success: {
    container: pair('#c6f2cb', '#18382b'),
    on: pair('#11401c', '#e0f4ea'),
    ink: pair('#257c3a', '#64d7aa'),
  },
  info: {
    container: pair('#e7dcf1', '#233147'),
    on: pair('#1b1122', '#e5efff'),
    ink: pair('#4d4356', '#8db8ff'),
  },
};

/**
 * The live gradient (DESIGN.md T-colour): its two OKLCH ends and the five sRGB fallback
 * stops that come first. The drift is applied by the component through relative colour.
 */
export const LIVE: TokenGroup = {
  title: 'T-colour: the live gradient',
  tokens: {
    'live-from': pair('oklch(42% 0.2 300)', 'oklch(72% 0.15 300)'),
    'live-to': pair('oklch(54% 0.22 350)', 'oklch(78% 0.15 350)'),
    'live-stop-1': pair('#611ba7', '#b48df4'),
    'live-stop-2': pair('#7b19a4', '#c98bec'),
    'live-stop-3': pair('#93169c', '#dd8be2'),
    'live-stop-4': pair('#ab1290', '#ef8bd4'),
    'live-stop-5': pair('#c20d80', '#fe8dc5'),
    'live-drift-from': '-16',
  },
};

/** The body face stack (DESIGN.md T-type). */
export const BODY_STACK =
  "system-ui, -apple-system, 'Segoe UI Variable Text', 'Segoe UI', 'Adwaita Sans', 'Cantarell', 'Noto Sans', 'Ubuntu', sans-serif";

/** Type steps in px: size and line height. Steps 4 to 8 are fluid (min → max). */
export const TYPE_STEPS: readonly { min: number; max: number; leading: number }[] = [
  { min: 11, max: 11, leading: 16 },
  { min: 12, max: 12, leading: 16 },
  { min: 13, max: 13, leading: 18 },
  { min: 14, max: 15, leading: 0 },
  { min: 16, max: 17, leading: 0 },
  { min: 20, max: 22, leading: 0 },
  { min: 24, max: 28, leading: 0 },
  { min: 32, max: 40, leading: 0 },
];

/** Geist's tracking per type step (DESIGN.md T-type: −.02em at 32 px up to .06em at 11 px). */
export const TRACKING = [
  '0.06em',
  '0.01em',
  '0',
  '0',
  '-0.005em',
  '-0.01em',
  '-0.015em',
  '-0.02em',
];

/** Fixed and fluid space steps in px (DESIGN.md T-space). */
export const SPACE_STEPS: readonly { name: string; min: number; max: number }[] = [
  { name: '1', min: 2, max: 2 },
  { name: '2', min: 4, max: 4 },
  { name: '2-5', min: 6, max: 6 },
  { name: '3', min: 8, max: 8 },
  { name: '3-5', min: 10, max: 10 },
  { name: '4', min: 12, max: 12 },
  { name: '5', min: 16, max: 20 },
  { name: '6', min: 24, max: 32 },
  { name: '7', min: 32, max: 40 },
  { name: '8', min: 48, max: 64 },
];

/** The fluid ramp, in px of container inline size (DESIGN.md F-fluid). */
export const FLUID_RAMP = { from: 400, to: 960 } as const;

/** Plain tokens that are the same in both themes and at both densities. */
export const PLAIN: TokenGroup[] = [
  {
    title: 'T-type: faces, weights and numbers',
    tokens: {
      'font-body': BODY_STACK,
      'font-head': `'Geist', 'Geist Fallback Segoe', 'Geist Fallback Arial', ${BODY_STACK}`,
      'weight-body': '400',
      'weight-strong': '600',
      'weight-head': '600',
      num: 'tabular-nums',
    },
  },
  {
    title: 'T-shape: lines',
    tokens: { 'line-hair': '1px', 'line-bold': '2px' },
  },
  {
    title: 'T-shape: radii',
    tokens: {
      'radius-pressed': '0.25rem',
      'radius-thumb': 'var(--radius-pressed)',
      'radius-thumb-pressed': '0.125rem',
      'radius-control': '0.5rem',
      'radius-group': '0.75rem',
      'radius-notice': 'var(--radius-group)',
      'radius-card': '1rem',
      'radius-dialog': '1.75rem',
      'radius-full': '999px',
    },
  },
  {
    title: 'T-shape: bevels (set with corner-shape inside @supports (corner-shape: bevel))',
    tokens: {
      'shape-bevel': '0.625rem',
      'shape-bevel-short': '0.5rem',
      'shape-bevel-small': '0.1875rem',
    },
  },
  {
    title: 'T-motion: durations and easings',
    tokens: {
      'dur-fast': '183ms',
      'dur-effects': '268ms',
      'dur-spatial': '480ms',
      'dur-step': '120ms',
      'dur-shape': 'var(--dur-effects)',
      'dur-fade-step': '500ms',
      'dur-drift': '8s',
      'ease-effects': 'cubic-bezier(0.3, 0, 0.1, 1)',
      'ease-spatial': 'cubic-bezier(0.34, 1.36, 0.64, 1)',
      'clack-animation': 'clack',
      'clack-dim': '30%',
    },
  },
  {
    title: 'T-state: layers, press scales and disabled',
    tokens: {
      'layer-hover': '8%',
      'layer-focus': '10%',
      'layer-press': '12%',
      'press-text': '0.96',
      'press-icon': '0.92',
      'press-wide': '0.98',
      'disabled-ink': '38%',
      'disabled-fill': '12%',
    },
  },
  {
    title: 'T-stack: stacking',
    tokens: { 'z-raised': '1', 'z-sticky': '2' },
  },
  {
    title: 'T-icon: icon sizes and stroke',
    tokens: {
      'icon-sm': '1rem',
      'icon-md': '1.25rem',
      'icon-lg': '1.5rem',
      'icon-stroke': '1.75',
    },
  },
  {
    title: 'T-size: fixed geometry',
    tokens: {
      'size-dot-sm': '0.375rem',
      'size-dot-md': '0.5rem',
      'size-badge': '1.25rem',
      'size-chip': '2rem',
      'size-track': '0.75rem',
      'size-handle-w': '0.25rem',
      'size-handle-h': '1.75rem',
      'size-art-md': '2.5rem',
      'size-art-lg': '3rem',
      'size-nav': '3rem',
      'rail-narrow': '4.5rem',
      'rail-wide': '13.5rem',
      'popup-inline': '22rem',
      'popup-block-max': '37.5rem',
      'page-max': '40rem',
      'ch-volume': '3ch',
      'ch-ms': '7ch',
      'ch-count': '2ch',
      'ch-ip': '15ch',
      'wide-control': '15rem',
    },
  },
  {
    title: 'F-grid: track constants',
    tokens: { 'track-option': '12rem', 'track-card': '18rem' },
  },
];

/** Tokens that `[data-density]` sets (DESIGN.md T-target and T-size). */
export const DENSITY: Record<string, DensityToken> = {
  'control-xs': { popup: '1.75rem', desktop: '1.75rem' },
  'control-sm': { popup: '2rem', desktop: '2.5rem' },
  'control-md': { popup: '2.25rem', desktop: '2.75rem' },
  'target-min': { popup: '1.5rem', desktop: '2.75rem' },
  'size-box': { popup: '1.125rem', desktop: '1.25rem' },
  'size-switch-w': { popup: '2.5rem', desktop: '3rem' },
  'size-switch-h': { popup: '1.5rem', desktop: '1.75rem' },
  'shape-bevel-thumb': { popup: '0.3125rem', desktop: '0.375rem' },
};

/** The one shadow (DESIGN.md T-elev), as two layers with a light/dark colour each. */
export const SHADOW_OVERLAY: readonly { geometry: string; color: ThemedToken }[] = [
  {
    geometry: '0 0.125rem 0.375rem',
    color: pair('oklch(20% 0.036 310 / 12%)', 'oklch(5% 0.02 302 / 50%)'),
  },
  {
    geometry: '0 0.5rem 1.5rem -0.5rem',
    color: pair('oklch(20% 0.036 310 / 36%)', 'oklch(5% 0.02 302 / 70%)'),
  },
];

/** Container-query breakpoints, in rem: the only literals allowed in `@container` (F-grid). */
export const CONTAINER_BREAKPOINTS_REM = [20, 25, 45] as const;

/** Timings used from script, in ms (DESIGN.md T-motion). */
export const TIMINGS = {
  TOOLTIP_DELAY_MS: 500,
  ANNOUNCE_GAP_MS: 150,
  BUSY_MIN_MS: 600,
} as const;

/** Colours drawn by Chrome or the OS, outside CSS (DESIGN.md T-chrome). */
export const CHROME = {
  toolbarBadge: {
    text: '!',
    warning: { light: { bg: '#935d00', fg: '#ffffff' }, dark: { bg: '#ffc251', fg: '#2b1d00' } },
    danger: { light: { bg: '#8c1116', fg: '#ffffff' }, dark: { bg: '#ef5f58', fg: '#3d090a' } },
  },
  tray: {
    idle: { light: 'tray/idle-light.png', dark: 'tray/idle-dark.png' },
    lit: { light: 'tray/lit-light.png', dark: 'tray/lit-dark.png' },
  },
} as const;
