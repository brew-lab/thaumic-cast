import type { ComponentChildren, JSX } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { Divider } from '../Divider';
import styles from './StickyActionBar.module.css';

/** The custom property the bar publishes on its scroller: its own block size. */
export const OVERLAY_END = '--overlay-end';

/** Props for {@link StickyActionBar}. */
export interface StickyActionBarProps {
  /** The Toast, above the actions (one at a time). */
  toast?: ComponentChildren;
  /** The actions: the CastBar, or the compact Wizard's Skip and Carry on. */
  children?: ComponentChildren;
}

/**
 * Finds the element that scrolls the bar's page: the nearest `[data-scroller]` (PopupShell),
 * else the document.
 * @param el - The bar
 * @returns The scroller
 */
export function scrollerOf(el: Element): HTMLElement {
  return (
    el.closest<HTMLElement>('[data-scroller]') ??
    (el.ownerDocument.scrollingElement as HTMLElement | null) ??
    el.ownerDocument.documentElement
  );
}

/**
 * The bar at the end of the one scroller (DESIGN.md L-bar): sticky to the end, on
 * `--surface`, at `--z-sticky`, holding the Toast and then the actions. It measures itself
 * and publishes its block size as `--overlay-end` on its scroller, which sets
 * its end scroll padding to `--overlay-end` plus `--space-3`, so a focused
 * control is never under it (WCAG 2.4.11). Its hairline shows only while content runs under
 * it (a scroll-state query); where those are missing it is always shown.
 * @param props - Component props
 * @param props.toast - The Toast
 * @param props.children - The actions
 * @returns The bar
 */
export function StickyActionBar({ toast, children }: StickyActionBarProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scroller = scrollerOf(el);
    const publish = (size: number): void => scroller.style.setProperty(OVERLAY_END, `${size}px`);
    publish(el.getBoundingClientRect().height);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      publish(entry.borderBoxSize?.[0]?.blockSize ?? el.getBoundingClientRect().height);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      scroller.style.removeProperty(OVERLAY_END);
    };
  }, []);
  return (
    <div ref={ref} class={styles.bar} data-sticky-bar="">
      <span class={styles.rule}>
        <Divider />
      </span>
      {toast}
      {children}
    </div>
  );
}
