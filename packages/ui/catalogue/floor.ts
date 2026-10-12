/*
 * The floor mode (`?floor=1`): the catalogue as the desktop's WebKit floor draws it (DESIGN.md
 * §10, the floors). Playwright's WebKit is newer than macOS 13's Safari 16.4: it has
 * light-dark(), corner-shape and the rest, so on its own it never draws webkit-fallbacks.css
 * or the paths written for the floor. This mode takes those features away from the page:
 *
 * - `CSS.supports()` answers no for them, before any component reads it (this module is
 *   imported first), so the Select draws the native list and the Tooltip places itself.
 * - Every `@supports (feature)` block that needs one of them is deleted, and every
 *   `@supports not (feature)` block is unwrapped, so the fallbacks apply: the generated
 *   token repeats, the pressed corner that stays, the instant fold, the fixed IP box.
 *
 * It is a test of the fallbacks, not of the engine: it cannot remove a feature the page uses
 * outside an `@supports` (check-ds.ts holds those). Two catalogue-only effects follow from
 * it: the fallback tokens follow the page theme, so both scheme panels draw in it (open the
 * page with ?theme=light and ?theme=dark), and the tooltip shown from the start is placed
 * once, at mount, so it can sit away from its trigger after the page scrolls.
 */

/** Words that mark a feature the desktop's WebKit floor lacks (DESIGN.md §10). */
const FLOOR_MISSING = [
  'light-dark(',
  'corner-shape',
  'text-box',
  'sibling-index(',
  'field-sizing',
  '::details-content',
  'interpolate-size',
  'base-select',
  'anchor-name',
  'from red',
];

/**
 * Whether a condition or a property names a feature the floor lacks.
 * @param text - An `@supports` condition, or a `CSS.supports()` argument
 * @returns True when the floor lacks it
 */
export function floorLacks(text: string): boolean {
  return FLOOR_MISSING.some((word) => text.includes(word));
}

/** Whether the page was opened in floor mode. */
export const floorMode =
  typeof location !== 'undefined' && new URLSearchParams(location.search).get('floor') === '1';

if (floorMode && typeof CSS !== 'undefined') {
  const supports = CSS.supports.bind(CSS) as (a: string, b?: string) => boolean;
  CSS.supports = ((a: string, b?: string): boolean =>
    floorLacks(`${a} ${b ?? ''}`)
      ? false
      : b === undefined
        ? supports(a)
        : supports(a, b)) as typeof CSS.supports;
  document.documentElement.setAttribute('data-floor', '');
}

/**
 * Deletes or unwraps the `@supports` blocks that name a floor feature, through a list of
 * rules and the groups inside it.
 * @param list - The rule list's owner
 */
function lowerRules(list: CSSStyleSheet | CSSGroupingRule): void {
  for (let i = 0; i < list.cssRules.length; i++) {
    const rule = list.cssRules[i];
    if (rule instanceof CSSSupportsRule && floorLacks(rule.conditionText)) {
      const negative = rule.conditionText.trim().startsWith('not');
      const inner = negative ? [...rule.cssRules].map((r) => r.cssText) : [];
      list.deleteRule(i);
      inner.forEach((text, k) => list.insertRule(text, i + k));
      // Look at this place again: it now holds the unwrapped rules, or the next one.
      i -= 1;
      continue;
    }
    if (rule instanceof CSSGroupingRule) lowerRules(rule);
  }
}

/** Applies floor mode to every stylesheet on the page; safe to run more than once. */
export function lowerStylesheets(): void {
  if (!floorMode) return;
  for (const sheet of document.styleSheets) {
    try {
      lowerRules(sheet);
    } catch {
      // A sheet from another origin cannot be read; the catalogue has none.
    }
  }
}
