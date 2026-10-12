import type { ComponentChildren, JSX } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { PageHeader } from '../PageHeader';
import { StickyActionBar } from '../StickyActionBar';
import { useFocusKeeper } from '../utils/focus';
import styles from './OptionsShell.module.css';

/** Props for {@link OptionsShell}. */
export interface OptionsShellProps {
  /** The page's title: "Settings". */
  title: string;
  /** One page-level Notice under the title (a failed save or load), or nothing. */
  notice?: ComponentChildren;
  /** The Toast (Undo after a removed set), or nothing: the bar is 0 tall without one. */
  toast?: ComponentChildren;
  /**
   * Still loading: the column is `aria-busy`, and the content is the loading words (an
   * EmptyState `searching`) in place of the sections.
   */
  busy?: boolean;
  /** The SettingsSections, `--space-5` apart. */
  children: ComponentChildren;
}

/**
 * The options page (DESIGN.md L-page): one column, `--page-max` wide and centred, in the
 * desktop density, with the PageHeader first, then the page's one Notice, then the sections
 * `--space-5` apart, and a StickyActionBar at the end that holds the Toast (0 tall while
 * there is none, so nothing comes and goes but the Toast). The document is the one scroller:
 * its end padding follows the bar (`--overlay-end` plus `--space-3`), so a focused control is
 * never under the Toast (WCAG 2.4.11), and its start padding keeps a section a link opens
 * (`#about`, `#audio-advanced`) clear of the window's edge. No status header and no footer.
 * When the focused control goes away (the Toast's Undo) focus moves to the next control.
 * @param props - Component props
 * @param props.title - The page's title
 * @param props.notice - The page's one Notice
 * @param props.toast - The Toast
 * @param props.busy - Still loading
 * @param props.children - The sections
 * @returns The page's frame
 */
export function OptionsShell({
  title,
  notice,
  toast,
  busy = false,
  children,
}: OptionsShellProps): JSX.Element {
  const ref = useRef<HTMLElement>(null);
  useFocusKeeper(ref);
  // The document is the page's scroller (base.css gives it the balanced stable gutter).
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-scroller', '');
  }, []);
  return (
    <div class={styles.shell} data-density="desktop">
      <main ref={ref} class={styles.column} aria-busy={busy ? 'true' : undefined}>
        <PageHeader title={title} />
        {notice}
        {children}
        <StickyActionBar toast={toast} />
      </main>
    </div>
  );
}
