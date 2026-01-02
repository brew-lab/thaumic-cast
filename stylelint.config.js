export default {
  extends: ['stylelint-config-standard'],
  rules: {
    // Allow OKLCH hue values without deg suffix (both are valid)
    'hue-degree-notation': 'number',
    // Enforce logical properties over physical
    'property-disallowed-list': [
      [
        // Margins
        'margin-top',
        'margin-right',
        'margin-bottom',
        'margin-left',
        // Paddings
        'padding-top',
        'padding-right',
        'padding-bottom',
        'padding-left',
        // Positioning
        'top',
        'right',
        'bottom',
        'left',
        // Border radius (individual corners)
        'border-top-left-radius',
        'border-top-right-radius',
        'border-bottom-left-radius',
        'border-bottom-right-radius',
        // Text alignment
        'text-align: left',
        'text-align: right',
      ],
      {
        message: 'Use logical properties instead (e.g., margin-inline-start, inset-block-start)',
      },
    ],
    // Allow modern CSS features
    'function-no-unknown': [true, { ignoreFunctions: ['theme', 'light-dark'] }],
    'at-rule-no-unknown': [true, { ignoreAtRules: ['tailwind', 'apply', 'layer'] }],
    // Allow CSS Modules pseudo-classes
    'selector-pseudo-class-no-unknown': [true, { ignorePseudoClasses: ['global', 'local'] }],
    // Consistent naming
    'selector-class-pattern': [
      '^[a-z][a-zA-Z0-9]*$',
      { message: 'Use camelCase for class names (CSS Modules)' },
    ],
  },
};
