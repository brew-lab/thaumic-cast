import type { ComponentChildren, JSX } from 'preact';
import { useCallback, useEffect, useId, useRef } from 'preact/hooks';
import { TOOLTIP_DELAY_MS } from '../tokens';
import { cx } from '../utils/cx';
import styles from './Tooltip.module.css';

/** Props for {@link Tooltip}. */
export interface TooltipProps {
  /** The words: the trigger's own name (an icon-only control), never anything interactive. */
  content: string;
  /** The trigger: one focusable control. */
  children: ComponentChildren;
  /**
   * A class for the wrapper, so a context can re-point the tooltip's tokens: a NavItem sets
   * `--tip-shown: none` outside the narrow rail, where its words are on screen.
   */
  class?: string;
  /** The trigger fills its container's inline size (a NavItem). */
  block?: boolean;
  /**
   * Shown from the start, until the pointer or focus leaves it or Esc: for the catalogue,
   * which draws the real tooltip without a hover. It is a manual popover then, so two can
   * be shown at once.
   */
  defaultOpen?: boolean;
}

const popoverKind = ((): 'hint' | 'manual' | null => {
  if (typeof document === 'undefined') return null;
  const probe = document.createElement('div');
  if (!('showPopover' in probe)) return null;
  probe.setAttribute('popover', 'hint');
  return probe.popover === 'hint' ? 'hint' : 'manual';
})();

const anchoring =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
    ? CSS.supports('anchor-name: --a')
    : false;

/**
 * Names a tooltip's anchor from a Preact id, as a CSS dashed ident.
 * @param id - The id from useId
 * @returns The anchor name
 */
export function anchorName(id: string): string {
  return `--tip-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

/**
 * A short label for an icon-only control (DESIGN.md A-tooltip): `popover="hint"`,
 * `role="tooltip"`, anchored above its trigger and flipped below at the edge, on the inverse
 * surface with the overlay shadow. It shows after `TOOLTIP_DELAY_MS` of hover, or at once on
 * keyboard focus; it can be hovered, stays while hovered or focused, and Esc hides it
 * (WCAG 1.4.13). It repeats a name the trigger already has, so it is `aria-hidden`. Where
 * anchor positioning is missing (the desktop's WebKit floor) a small placer positions it.
 * @param props - Component props
 * @param props.content - The words
 * @param props.children - The trigger
 * @param props.class - A class for the wrapper
 * @param props.block - The trigger fills its container
 * @param props.defaultOpen - Shown from the start
 * @returns The trigger with its tooltip
 */
export function Tooltip({
  content,
  children,
  class: className,
  block = false,
  defaultOpen = false,
}: TooltipProps): JSX.Element {
  const anchor = anchorName(useId());
  const wrap = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const over = useRef({ trigger: false, tip: false, focus: false });

  const clear = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const hide = useCallback((): void => {
    clear();
    const el = tip.current;
    if (!el) return;
    if (popoverKind && el.matches(':popover-open')) el.hidePopover();
    el.removeAttribute('data-open');
  }, []);

  const show = useCallback((): void => {
    clear();
    const el = tip.current;
    const trigger = wrap.current;
    if (!el || !trigger) return;
    if (!anchoring) {
      const box = trigger.getBoundingClientRect();
      el.style.setProperty('--tip-x', `${box.left + box.width / 2}px`);
      el.style.setProperty('--tip-y', `${box.top}px`);
    }
    if (popoverKind && !el.matches(':popover-open')) el.showPopover();
    el.setAttribute('data-open', '');
  }, []);

  const maybeHide = (): void => {
    // Let the pointer cross from the trigger onto the tooltip without it closing.
    clear();
    timer.current = setTimeout(() => {
      const o = over.current;
      if (!o.trigger && !o.tip && !o.focus) hide();
    }, 100);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // An Esc that hides a shown tooltip is the tooltip's: nothing else acts on it (a Toast
      // would otherwise go with it, and its Undo).
      if (event.key === 'Escape' && tip.current?.hasAttribute('data-open')) {
        event.preventDefault();
        hide();
      }
    };
    // Capture, so the tooltip hears Esc before anything listening on the document.
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      clear();
    };
  }, [hide]);

  useEffect(() => {
    if (defaultOpen) show();
  }, [defaultOpen, show]);

  const popover = popoverKind ? { popover: defaultOpen ? 'manual' : popoverKind } : {};

  return (
    <span
      ref={wrap}
      class={cx(styles.anchor, block && styles.block, className)}
      style={{ '--tip-anchor': anchor }}
      onPointerEnter={() => {
        over.current.trigger = true;
        clear();
        timer.current = setTimeout(show, TOOLTIP_DELAY_MS);
      }}
      onPointerLeave={() => {
        over.current.trigger = false;
        maybeHide();
      }}
      onFocusIn={(event) => {
        if ((event.target as Element).matches(':focus-visible')) {
          over.current.focus = true;
          show();
        }
      }}
      onFocusOut={() => {
        over.current.focus = false;
        hide();
      }}
    >
      {children}
      <span
        ref={tip}
        class={styles.tip}
        role="tooltip"
        aria-hidden="true"
        {...popover}
        onPointerEnter={() => {
          over.current.tip = true;
          clear();
        }}
        onPointerLeave={() => {
          over.current.tip = false;
          maybeHide();
        }}
      >
        {content}
      </span>
    </span>
  );
}
