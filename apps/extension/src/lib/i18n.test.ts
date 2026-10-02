import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { resetChromeStub } from '../test-support/chrome-stub';
import { SUPPORTED_LOCALES, detectLanguage, getInitialLanguage, hasLanguageChoice } from './i18n';

let uiLanguage: ReturnType<typeof spyOn>;

beforeEach(() => {
  resetChromeStub();
  uiLanguage = spyOn(chrome.i18n, 'getUILanguage').mockReturnValue('en-GB');
});

afterEach(() => {
  uiLanguage.mockRestore();
});

describe('getInitialLanguage', () => {
  it('should detect from the browser when the stored language is auto', () => {
    expect(getInitialLanguage('auto')).toBe(detectLanguage());
    expect(getInitialLanguage('auto')).toBe('en');
    // Once for detectLanguage above, once for each 'auto'.
    expect(uiLanguage).toHaveBeenCalledTimes(3);
  });

  it('should detect from the browser when nothing is stored', () => {
    expect(getInitialLanguage(null)).toBe('en');
    expect(getInitialLanguage()).toBe('en');
    expect(uiLanguage).toHaveBeenCalledTimes(2);
  });

  it('should use an explicit choice without asking the browser', () => {
    expect(getInitialLanguage('en')).toBe('en');
    expect(uiLanguage).not.toHaveBeenCalled();
  });

  it('should detect from the browser for a language that is not shipped', () => {
    expect(getInitialLanguage('xx')).toBe('en');
    expect(uiLanguage).toHaveBeenCalledTimes(1);
  });
});

describe('hasLanguageChoice', () => {
  it('should show the Language section with two locales and not with one', () => {
    expect(hasLanguageChoice(['en', 'fr'])).toBe(true);
    expect(hasLanguageChoice(['en'])).toBe(false);
    expect(hasLanguageChoice([])).toBe(false);
  });

  it('should follow the locales that ship by default', () => {
    expect(hasLanguageChoice()).toBe(SUPPORTED_LOCALES.length > 1);
  });
});
