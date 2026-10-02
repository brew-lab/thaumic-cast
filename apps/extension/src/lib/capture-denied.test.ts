import { describe, expect, it } from 'bun:test';
import i18next from 'i18next';

import en from '../locales/en.json';
import {
  CAPTURE_DENIED_REASON_MAX,
  captureDeniedError,
  captureDeniedReason,
} from './capture-denied';
import { KeyedError, errorParamsOf } from './keyed-error';

describe('captureDeniedError', () => {
  it("should carry Chrome's reason beside its own key when Chrome gave one", () => {
    const err = captureDeniedError('Chrome pages cannot be captured.');

    expect(err).toBeInstanceOf(KeyedError);
    expect(err.message).toBe('error_capture_denied_reason');
    expect(errorParamsOf(err)).toEqual({ reason: 'Chrome pages cannot be captured.' });
  });

  it('should fall back to the reason-free key when Chrome gave none', () => {
    for (const reason of [undefined, '', '  \n ']) {
      const err = captureDeniedError(reason);
      expect(err.message).toBe('error_capture_denied');
      expect(errorParamsOf(err)).toBeUndefined();
    }
  });

  it('should put the reason on one line and cut one too long for the popup', () => {
    expect(captureDeniedReason('  Cannot capture\n a tab  ')).toBe('Cannot capture a tab');
    const long = captureDeniedReason('x'.repeat(400));
    expect(long).toHaveLength(CAPTURE_DENIED_REASON_MAX);
    expect(long?.endsWith('…')).toBe(true);
  });

  it("should render Chrome's reason unescaped inside the sentence", async () => {
    const i18n = i18next.createInstance();
    await i18n.init({
      lng: 'en',
      resources: { en: { translation: en } },
      interpolation: { escapeValue: false },
    });
    const err = captureDeniedError("Extension has not been invoked for the current page's tab.");

    expect(i18n.t(err.message, errorParamsOf(err) ?? {})).toBe(
      "Chrome would not hand over this tab's audio, and wrote its reason down: “Extension has " +
        "not been invoked for the current page's tab.” Try another tab.",
    );
  });
});
