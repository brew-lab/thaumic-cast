import { describe, expect, it } from 'bun:test';

import { hasLanguageChoice } from './language-choice';

describe('hasLanguageChoice', () => {
  it('should show the Language section with two locales and not with one', () => {
    expect(hasLanguageChoice(['en', 'fr'])).toBe(true);
    expect(hasLanguageChoice(['en'])).toBe(false);
    expect(hasLanguageChoice([])).toBe(false);
  });
});
