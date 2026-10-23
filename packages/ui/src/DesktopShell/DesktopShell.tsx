import type { ComponentChildren, JSX } from 'preact';
import { useRef } from 'preact/hooks';
import { useFocusKeeper } from '../utils/focus';
import { cx } from '../utils/cx';
import styles from './DesktopShell.module.css';

/** Props for {@link DesktopShell}. */
export interface DesktopShellProps {
  /** The Rail. */
  rail: ComponentChildren;
  /** The one Toast (what Stop all casts stopped), or nothing: the row is 0 tall without one. */
  toast?: ComponentChildren;
  /**
   * The view runs the main's full width (Rooms, for its card grid). Otherwise the view
   * keeps to `--page-max` (Server, Settings, Not found).
   */
  wide?: boolean;
  /** The view: its PageHeader first, then its parts, `--space-5` apart. */
  children: ComponentChildren;
}

/**
 * The desktop window (DESIGN.md L-desktop): the Rail beside main, as tall as the window.
 * The window is the `app` container, and the shell owns its one breakpoint: the rail is
 * `--rail-narrow` under 45rem and `--rail-wide` from it. Main is the `content` container
 * (fluid type and space follow the column, not the window) and the one scroller, padded by
 * `--space-7`; the view is a `--space-5` stack in it. The toast row sits under main, outside
 * the scroller, and is 0 tall until a Toast opens it, so a Toast never covers the focused
 * control. When the focused control goes away (Stop all casts once nothing casts), focus
 * moves to the next control rather than falling to the page.
 * @param props - Component props
 * @param props.rail - The Rail
 * @param props.toast - The Toast
 * @param props.wide - The view runs the full width
 * @param props.children - The view
 * @returns The window's frame
 */
export function DesktopShell({
  rail,
  toast,
  wide = false,
  children,
}: DesktopShellProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useFocusKeeper(ref);
  return (
    <div ref={ref} class={styles.shell} data-density="desktop">
      <div class={styles.frame}>
        {rail}
        <div class={styles.column}>
          <main class={styles.main} data-scroller="">
            <div class={cx(styles.view, wide && styles.wide)}>{children}</div>
          </main>
          <div class={styles.toast} data-toast-row="">
            {toast}
          </div>
        </div>
      </div>
    </div>
  );
}
