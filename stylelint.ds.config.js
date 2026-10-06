/**
 * The design-system stylelint rules (packages/ui/DESIGN.md §10, rows 1 and 2), on top of
 * the main config. `bun run lint:ds` runs them as a report; Phase 5 moves them into
 * stylelint.config.js as errors, once the apps are rebuilt from the design system.
 */
import base from './stylelint.config.js';

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
        '/^((var\\(--[\\w-]+\\)|calc\\([^;]*\\)|0|100%|auto|1fr|min-content|max-content|none|inherit)\\s*)+$/',
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
  'property-disallowed-list': ['transition', 'animation'],
};

/**
 * The files in packages/ui that hold raw values (DESIGN.md §10): the generated tokens, the
 * base layer, and the two files whose literals the spec writes out (utilities, @font-face).
 */
export const RAW_VALUE_FILES = [
  'packages/ui/src/tokens.css',
  'packages/ui/src/webkit-fallbacks.css',
  'packages/ui/src/base.css',
  'packages/ui/src/utilities.css',
  'packages/ui/src/fonts.css',
];

export default {
  ...base,
  overrides: [
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
