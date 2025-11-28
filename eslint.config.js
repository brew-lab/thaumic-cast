import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default [
  {
    ignores: ['**/dist/**', '**/public/**', '**/node_modules/**'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['**/vite.config.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: true,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['extension/vite.config.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: path.join(__dirname, 'extension/tsconfig.node.json'),
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
    },
  },
  {
    files: ['server/ui/vite.config.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: path.join(__dirname, 'server/ui/tsconfig.node.json'),
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
    },
  },
];
