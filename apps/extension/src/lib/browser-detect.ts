/**
 * Identifies which browser executable this extension is running in, so the
 * companion captures the right process tree.
 *
 * Browser-wide capture attaches to one browser's process tree by executable
 * name. Left to guess, the companion captures whichever supported browser has
 * the lowest process id, which is simply the one that started first. On a
 * machine where another browser sits in the background, that is the wrong
 * one, and the result is a perfectly timed stream of silence.
 */

/** Executable names the companion's capture knows how to attach to. */
export type BrowserExecutable = 'chrome.exe' | 'brave.exe' | 'msedge.exe';

/** The parts of `navigator` that identify the browser. */
export interface BrowserIdentity {
  /** `navigator.userAgent`. Brave and Edge both report Chrome here. */
  userAgent: string;
  /** `navigator.userAgentData.brands`, when the browser exposes client hints. */
  brands?: readonly { brand: string }[];
}

/**
 * Maps a browser identity onto the executable the companion should capture.
 *
 * Client-hint brands are authoritative: Brave and Edge both disguise
 * themselves as Chrome in the user-agent string but name themselves in the
 * brand list. The string is only a fallback, and a browser this does not
 * recognise yields `undefined` so the companion falls back to its own
 * detection rather than being told to capture a process that is not there.
 * @param identity - The browser's user agent and, if available, its brands
 * @returns The executable name to capture, or undefined if unknown
 */
export function browserExecutableFor(identity: BrowserIdentity): BrowserExecutable | undefined {
  if (identity.brands && identity.brands.length > 0) {
    // Every Chromium browser exposes client hints, and each names itself in
    // the brand list, so when brands are present they decide alone: a list
    // naming none of the supported browsers is a browser we cannot capture,
    // whatever its user-agent string claims.
    const brands = identity.brands.map((entry) => entry.brand.toLowerCase());
    if (brands.some((brand) => brand.includes('brave'))) return 'brave.exe';
    if (brands.some((brand) => brand.includes('edge'))) return 'msedge.exe';
    if (brands.some((brand) => brand.includes('google chrome'))) return 'chrome.exe';
    return undefined;
  }

  const ua = identity.userAgent;
  if (/\bEdg(?:e|A|iOS)?\//.test(ua)) return 'msedge.exe';
  if (/\bBrave\b/.test(ua)) return 'brave.exe';
  // Chromium-based browsers the companion does not know (Vivaldi, Opera, Arc)
  // also say Chrome; naming chrome.exe for them would point at a process that
  // may not exist, so only an otherwise unbranded Chrome string maps here.
  if (/\bChrome\//.test(ua) && !/\b(?:Vivaldi|OPR|Arc)\//.test(ua)) return 'chrome.exe';
  return undefined;
}

/**
 * Identifies the running browser from the global `navigator`.
 * @returns The executable name to capture, or undefined if it cannot be told
 */
export function detectBrowserExecutable(): BrowserExecutable | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const nav = navigator as Navigator & {
    userAgentData?: { brands?: readonly { brand: string }[] };
  };
  return browserExecutableFor({
    userAgent: nav.userAgent ?? '',
    brands: nav.userAgentData?.brands,
  });
}
