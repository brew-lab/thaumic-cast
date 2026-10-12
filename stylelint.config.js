/**
 * The scrollbar is one foundation in packages/ui/src/base.css (DESIGN.md F-shift): its width,
 * its colours and the balanced gutter of every page scroller. Nothing else styles one.
 */
const SCROLLBAR_PROPERTIES = ['/^scrollbar-/'];

/*
 * The design-system rules (packages/ui/DESIGN.md §10, rows 1 and 2) are errors like every
 * other rule: app CSS holds only tokens and layout, and packages/ui CSS takes its values from
 * the tokens, except the files that hold the raw values.
 */

/** Row 1: the value properties may hold only tokens, calc() over tokens and safe literals. */
const VALUES_FROM_TOKENS = {
  'declaration-property-value-allowed-list': {
    '/^(color|background(-color)?|border(-.+)?-color|outline-color|fill|stroke|box-shadow|text-decoration-color)$/':
      ['/^(var\\(--[\\w-]+\\)|currentcolor|transparent|inherit|none)$/i'],
    '/^(font-(size|weight|family)|line-height|letter-spacing|z-index)$/': [
      '/^var\\(--[\\w-]+\\)$/',
    ],
    '/^(gap|row-gap|column-gap|padding.*|margin.*|inset.*|border(-.+)?-(width|radius)|border-radius|outline-(width|offset)|(min-|max-)?(inline|block)-size|(transition|animation)-(duration|delay|timing-function))$/':
      [
        '/^((var\\(--[\\w-]+\\)|calc\\([^;]*\\)|0|100%|auto|1fr|min-content|max-content|none|inherit|100dvb)\\s*)+$/',
      ],
  },
};

/** Row 2: no raw colour, no units, no local motion or queries, no !important. */
const APP_ONLY = {
  'function-disallowed-list': [
    'rgb',
    'rgba',
    'hsl',
    'hsla',
    'hwb',
    'lab',
    'lch',
    'oklch',
    'color',
    'color-mix',
  ],
  'unit-disallowed-list': ['px', 'rem', 'em', 'ch', 'ms', 's', 'deg'],
  'at-rule-disallowed-list': ['keyframes', 'container', 'media'],
  'declaration-no-important': true,
  // Longhands only, so every time and ease is a token.
  // The scrollbar is styled once, in base.css (F-shift), as the main config says.
  'property-disallowed-list': ['transition', 'animation', ...SCROLLBAR_PROPERTIES],
};

/**
 * The files in packages/ui that hold raw values (DESIGN.md §10): the generated tokens, the
 * base layer, and the two files whose literals the spec writes out (utilities, @font-face).
 */
const RAW_VALUE_FILES = [
  'packages/ui/src/tokens.css',
  'packages/ui/src/webkit-fallbacks.css',
  'packages/ui/src/base.css',
  'packages/ui/src/utilities.css',
  'packages/ui/src/fonts.css',
];

export default {
  extends: ['stylelint-config-standard'],
  plugins: ['stylelint-use-logical'],
  ignoreFiles: [
    '**/dist/**',
    '**/node_modules/**',
    '**/target/**',
    '**/old/**',
    '.claude/worktrees/**',
  ],
  rules: {
    // Allow OKLCH hue values without deg suffix (both are valid)
    'hue-degree-notation': 'number',
    // Enforce logical properties over physical
    'csstools/use-logical': ['always', { severity: 'error' }],
    // Disallow physical text-align values
    'declaration-property-value-disallowed-list': {
      'text-align': ['left', 'right'],
      float: ['left', 'right'],
      clear: ['left', 'right'],
    },
    // Allow modern CSS features
    'function-no-unknown': [true, { ignoreFunctions: ['theme', 'light-dark'] }],
    'at-rule-no-unknown': [true, { ignoreAtRules: ['layer'] }],
    // The design system's hover and focus bevel (packages/ui/DESIGN.md T-shape), always set
    // inside @supports (corner-shape: bevel).
    'property-no-unknown': [true, { ignoreProperties: ['corner-shape'] }],
    // Modern CSS syntax
    'length-zero-no-unit': true,
    'color-function-notation': 'modern',
    // Enforce theme variables and OKLCH for colors
    'color-no-hex': true,
    'color-named': 'never',
    'function-disallowed-list': ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'color'],
    // The scrollbar is styled once, in base.css (F-shift).
    'property-disallowed-list': SCROLLBAR_PROPERTIES,
    'selector-pseudo-element-disallowed-list': ['/scrollbar/'],
    // Consistent naming (kebab-case)
    'selector-class-pattern': [
      '^[a-z][a-z0-9]*(-[a-z0-9]+)*$',
      { message: 'Use kebab-case for class names' },
    ],
  },
  overrides: [
    {
      // The design system's modules write each control's states in the F-grammar order
      // (rest, hover, focus, press, then on, busy, disabled; DESIGN.md §3), which is the
      // order the cascade needs, not the order of specificity.
      files: ['packages/ui/src/**/*.module.css'],
      rules: { 'no-descending-specificity': null },
    },
    {
      // The one place the scrollbar is styled (F-shift).
      files: ['packages/ui/src/base.css'],
      rules: {
        'property-disallowed-list': null,
        'selector-pseudo-element-disallowed-list': null,
      },
    },
    {
      files: ['apps/**/*.css'],
      rules: { ...VALUES_FROM_TOKENS, ...APP_ONLY },
    },
    {
      files: ['packages/ui/src/**/*.css'],
      rules: VALUES_FROM_TOKENS,
    },
    {
      files: RAW_VALUE_FILES,
      rules: { 'declaration-property-value-allowed-list': null },
    },
  ],
};
