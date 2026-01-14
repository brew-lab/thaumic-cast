export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      ['desktop', 'extension', 'protocol', 'ui', 'core', 'server', 'docs', 'ci', 'deps'],
    ],
  },
};
