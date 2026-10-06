/**
 * The design-system eslint rules (packages/ui/DESIGN.md §10, row 4): apps import design-system
 * components from @thaumic-cast/ui only, draw glyphs with Icon, and render no raw controls,
 * live regions or inline styles. `bun run lint:ds` runs them as a report; Phase 5 moves them
 * into eslint.config.js as errors. It extends the main config, so it can run on its own.
 */
import base from './eslint.config.js';

const RAW_CONTROL = 'Use the design-system component from @thaumic-cast/ui instead.';

export default [
  ...base,
  {
    files: ['apps/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'lucide-preact', message: 'Draw glyphs with Icon from @thaumic-cast/ui.' },
          ],
          patterns: [
            {
              group: ['@thaumic-cast/ui/src/*', '**/packages/ui/src/*'],
              message: 'Import from @thaumic-cast/ui only.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXOpeningElement[name.name=/^(button|input|select|textarea|dialog)$/]',
          message: RAW_CONTROL,
        },
        {
          selector: "JSXAttribute[name.name='role'][value.value='alert']",
          message: 'Say it through the Announcer (useAnnouncer) instead.',
        },
        {
          selector: "JSXAttribute[name.name='aria-live']",
          message: 'Say it through the Announcer (useAnnouncer) instead.',
        },
        {
          selector: "JSXAttribute[name.name='style'][value.type='Literal']",
          message: 'Inline style may only carry a custom property.',
        },
        {
          selector:
            "JSXAttribute[name.name='style'] ObjectExpression > Property > Identifier.key, JSXAttribute[name.name='style'] ObjectExpression > Property > Literal.key[value!=/^--/]",
          message: 'Inline style may only carry a custom property.',
        },
      ],
    },
  },
];
