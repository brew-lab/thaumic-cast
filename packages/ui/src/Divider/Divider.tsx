import type { JSX } from 'preact';
import styles from './Divider.module.css';

/**
 * A hairline of `--divider` (DESIGN.md A-divider): the StickyActionBar edge, between groups
 * inside one Card, and the compact Wizard footer. It is decoration, so `aria-hidden`; there
 * is no `inset` prop.
 * @returns The rule
 */
export function Divider(): JSX.Element {
  return <hr class={styles.divider} aria-hidden="true" />;
}
