import type { ComponentChildren, JSX } from 'preact';
import { useRef } from 'preact/hooks';
import { cx } from '../utils/cx';
import { useFocusKeeper } from '../utils/focus';
import styles from './PopupShell.module.css';

/** Props for {@link PopupShell}. */
export interface PopupShellProps {
  /** The PopupHeader. */
  header: ComponentChildren;
  /** The banner: one Notice `banner`, or nothing. */
  banner?: ComponentChildren;
  /** The away line: one NoticeLine, or nothing. */
  away?: ComponentChildren;
  /** The content: "Casting now" and the CastTiles, then the TabCard. */
  children: ComponentChildren;
  /** The StickyActionBar, holding the Toast and the CastBar (or the Wizard's Skip and Carry on). */
  bar: ComponentChildren;
  /**
   * As tall as the popup can be (`--popup-block-max`) whatever the content, with the content
   * filling it and the bar at its end: the compact Wizard (L-wizard), so the popup never
   * changes size from one step to the next.
   */
  fill?: boolean;
}

/**
 * The popup (DESIGN.md L-popup): one scroller, `--popup-inline` wide and at most
 * `--popup-block-max` tall, with its gutter stable on both edges (base.css), so nothing inside ever scrolls
 * on its own and long content folds in place. The order is fixed by the slots, and is the
 * reading and Tab order: PopupHeader › banner › away line › content › StickyActionBar. There
 * is no footer, no end row and no version line ("Update available" is a mark on Settings).
 * The scroller's end padding follows the bar (`--overlay-end`, which the StickyActionBar
 * publishes, plus `--space-3`), so a focused control is never under it (WCAG 2.4.11). Without a bar its last card keeps `--space-4` from
 * the end. When the focused control goes away (a notice's X, the Toast's Undo) focus moves to
 * the next control, never to `<body>` (WCAG 2.4.3). It is the popup's `app` container.
 * @param props - Component props
 * @param props.header - The PopupHeader
 * @param props.banner - The banner
 * @param props.away - The away line
 * @param props.children - The content
 * @param props.bar - The StickyActionBar
 * @param props.fill - As tall as the popup can be
 * @returns The popup's frame
 */
export function PopupShell({
  header,
  banner,
  away,
  children,
  bar,
  fill = false,
}: PopupShellProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useFocusKeeper(ref);
  return (
    <div ref={ref} class={cx(styles.shell, fill && styles.fill)} data-scroller="">
      {header}
      {banner}
      {away}
      <main class={styles.content}>{children}</main>
      {bar}
    </div>
  );
}
