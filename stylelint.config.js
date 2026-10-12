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
  ],
};
