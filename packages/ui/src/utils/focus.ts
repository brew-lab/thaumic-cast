import type { RefObject } from 'preact';
import { useEffect } from 'preact/hooks';

/** What can take focus from the keyboard, before it is checked for being shown and enabled. */
const FOCUSABLE = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Whether an element can take focus now: in the document, drawn, enabled and not inert.
 * @param el - The element
 * @returns True when it can
 */
export function canTakeFocus(el: HTMLElement): boolean {
  return (
    el.isConnected &&
    !el.matches(':disabled') &&
    !el.closest('[inert]') &&
    el.getClientRects().length > 0
  );
}

/**
 * The element focus lands on when the focused control goes away (WCAG 2.4.3): the next control
 * that was after it and is still there, else the nearest one before it.
 * @param order - The focusable elements as they were, in document order
 * @param index - Where the control that went away was in it
 * @returns The element, or null when none is left
 */
export function focusNeighbour(order: readonly HTMLElement[], index: number): HTMLElement | null {
  for (let i = index + 1; i < order.length; i++) if (canTakeFocus(order[i])) return order[i];
  for (let i = index - 1; i >= 0; i--) if (canTakeFocus(order[i])) return order[i];
  return null;
}

/**
 * Keeps focus in a region when the focused control is removed (a notice's X, the Toast's Undo,
 * the add mode's Cancel): instead of falling to `<body>`, focus moves to the next control that
 * was after it, else the nearest before it. A component that knows a better place (a form's
 * field, the trigger that opened what went) moves focus itself in a layout effect, which runs
 * first; this only catches what is left on `<body>`.
 * @param ref - The region, such as the popup's scroller
 */
export function useFocusKeeper(ref: RefObject<HTMLElement>): void {
  useEffect(() => {
    const region = ref.current;
    if (!region || typeof MutationObserver === 'undefined') return;
    let order: HTMLElement[] = [];
    let focused: HTMLElement | null = null;

    const onFocusIn = (event: FocusEvent): void => {
      focused = event.target instanceof HTMLElement ? event.target : null;
      order = [...region.querySelectorAll<HTMLElement>(FOCUSABLE)];
    };

    // Focus left for nothing (a click on the page's background) while the control stays:
    // its later removal is not this region's to answer.
    const onFocusOut = (event: FocusEvent): void => {
      const left = event.target;
      queueMicrotask(() => {
        if (left === focused && focused?.isConnected) focused = null;
      });
    };

    const observer = new MutationObserver(() => {
      const doc = region.ownerDocument;
      if (!focused || focused.isConnected) return;
      const active = doc.activeElement;
      if (active && active !== doc.body && active !== doc.documentElement) return;
      const next = focusNeighbour(order, order.indexOf(focused));
      focused = null;
      next?.focus();
    });

    region.addEventListener('focusin', onFocusIn);
    region.addEventListener('focusout', onFocusOut);
    observer.observe(region, { childList: true, subtree: true });
    return () => {
      region.removeEventListener('focusin', onFocusIn);
      region.removeEventListener('focusout', onFocusOut);
      observer.disconnect();
    };
  }, []);
}
