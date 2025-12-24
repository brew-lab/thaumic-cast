export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [2, 'always', ['desktop', 'extension', 'protocol', 'ui', 'docs', 'ci', 'deps']],
  },
};
