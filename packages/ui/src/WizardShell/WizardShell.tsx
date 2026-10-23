import type { ComponentChildren, JSX } from 'preact';
import { useRef } from 'preact/hooks';
import { useFocusKeeper } from '../utils/focus';
import styles from './WizardShell.module.css';

/** Props for {@link WizardShell}. */
export interface WizardShellProps {
  /** The Wizard, in its full form. */
  children: ComponentChildren;
}

/**
 * The desktop's onboarding window (DESIGN.md L-wizard, full): the DesktopShell without the
 * Rail. The window is the `app` container; main is the `content` container and the one
 * scroller, padded by `--space-7`, with the Wizard centred in a `--page-max` column at least
 * as tall as the window, so its footer sits at the window's end on every step. The Wizard is
 * the whole window, so it is not a modal dialog.
 * @param props - Component props
 * @param props.children - The Wizard
 * @returns The window's frame
 */
export function WizardShell({ children }: WizardShellProps): JSX.Element {
  const ref = useRef<HTMLElement>(null);
  useFocusKeeper(ref);
  return (
    <div class={styles.shell} data-density="desktop">
      <main ref={ref} class={styles.main} data-scroller="">
        <div class={styles.column}>{children}</div>
      </main>
    </div>
  );
}
