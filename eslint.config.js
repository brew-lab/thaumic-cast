import jsdoc from 'eslint-plugin-jsdoc';
import typescriptEslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

const RAW_CONTROL = 'Use the design-system component from @thaumic-cast/ui instead.';

export default [
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/target/**', 'old/**', '.claude/worktrees/**'],
  },
  ...typescriptEslint.configs.recommended,
  prettierConfig,
  {
    plugins: {
      jsdoc,
    },
    rules: {
      'jsdoc/require-jsdoc': [
        'warn',
        {
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ClassDeclaration: true,
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
        },
      ],
      'jsdoc/require-description': 'warn',
      'jsdoc/require-param': 'warn',
      'jsdoc/require-returns': 'warn',
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      // Test names document the behaviour; a JSDoc block per helper adds noise.
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-param': 'off',
      'jsdoc/require-returns': 'off',
    },
  },
  {
    // The design-system rules (packages/ui/DESIGN.md §10, row 4): apps import its components
    // from @thaumic-cast/ui only, draw glyphs with Icon, and render no raw controls, live
    // regions or inline styles.
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
