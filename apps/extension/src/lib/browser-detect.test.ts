import { describe, expect, it } from 'bun:test';

import { browserExecutableFor } from './browser-detect';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

describe('browserExecutableFor', () => {
  it('should name Brave from its brand even though its user agent says Chrome', () => {
    const brands = [{ brand: 'Brave' }, { brand: 'Chromium' }, { brand: 'Not_A Brand' }];
    expect(browserExecutableFor({ userAgent: CHROME_UA, brands })).toBe('brave.exe');
  });

  it('should name Edge from its brand', () => {
    const brands = [{ brand: 'Microsoft Edge' }, { brand: 'Chromium' }, { brand: 'Not_A Brand' }];
    expect(browserExecutableFor({ userAgent: `${CHROME_UA} Edg/129.0.0.0`, brands })).toBe(
      'msedge.exe',
    );
  });

  it('should name Chrome from its brand', () => {
    const brands = [{ brand: 'Google Chrome' }, { brand: 'Chromium' }, { brand: 'Not_A Brand' }];
    expect(browserExecutableFor({ userAgent: CHROME_UA, brands })).toBe('chrome.exe');
  });

  it('should fall back to the user agent when brands are unavailable', () => {
    expect(browserExecutableFor({ userAgent: `${CHROME_UA} Edg/129.0.0.0` })).toBe('msedge.exe');
    expect(browserExecutableFor({ userAgent: CHROME_UA })).toBe('chrome.exe');
  });

  it('should not name chrome.exe for a Chromium browser the companion cannot capture', () => {
    const brands = [{ brand: 'Vivaldi' }, { brand: 'Chromium' }];
    expect(browserExecutableFor({ userAgent: CHROME_UA, brands })).toBeUndefined();
    expect(browserExecutableFor({ userAgent: `${CHROME_UA} OPR/115.0.0.0` })).toBeUndefined();
    expect(browserExecutableFor({ userAgent: `${CHROME_UA} Vivaldi/7.0` })).toBeUndefined();
  });

  it('should leave the decision to the companion for a browser it does not recognise', () => {
    expect(browserExecutableFor({ userAgent: 'Mozilla/5.0 Firefox/130.0' })).toBeUndefined();
  });
});
