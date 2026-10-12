import type { ComponentChildren, JSX } from 'preact';
import { useCallback, useEffect, useId, useRef } from 'preact/hooks';
import { TOOLTIP_DELAY_MS } from '../tokens';
import styles from './Tooltip.module.css';

/** Props for {@link Tooltip}. */
export interface TooltipProps {
  /** The words: the trigger's own name (an icon-only control), never anything interactive. */
  content: string;
  /** The trigger: one focusable control. */
  children: ComponentChildren;
  /**
   * Shows the tooltip only while this returns true, e.g. only while a NavItem's label is
   * hidden in the narrow rail.
   */
  when?: () => boolean;
  /** The trigger fills its container's inline size (a NavItem). */
  block?: boolean;
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
 * @param props.when - Shows only while this returns true
 * @param props.block - The trigger fills its container
 * @returns The trigger with its tooltip
 */
export function Tooltip({ content, children, when, block = false }: TooltipProps): JSX.Element {
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
    if (!el || !trigger || (when && !when())) return;
    if (!anchoring) {
      const box = trigger.getBoundingClientRect();
      el.style.setProperty('--tip-x', `${box.left + box.width / 2}px`);
      el.style.setProperty('--tip-y', `${box.top}px`);
    }
    if (popoverKind && !el.matches(':popover-open')) el.showPopover();
    el.setAttribute('data-open', '');
  }, [when]);

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
      if (event.key === 'Escape') hide();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      clear();
    };
  }, [hide]);

  const popover = popoverKind ? { popover: popoverKind } : {};

  return (
    <span
      ref={wrap}
      class={block ? `${styles.anchor} ${styles.block}` : styles.anchor}
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
