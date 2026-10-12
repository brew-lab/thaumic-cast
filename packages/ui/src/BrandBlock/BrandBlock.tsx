import type { JSX } from 'preact';
import { cx } from '../utils/cx';
import { Mark } from './Mark';
import styles from './BrandBlock.module.css';

/** Props for {@link BrandBlock}. */
export interface BrandBlockProps {
  /** The product name, "Thaumic Cast". */
  name: string;
  /** Casting: the mark is lit. */
  lit?: boolean;
  /**
   * header: the popup's header. rail: the desktop rail, with the version line; under a
   * 45rem window the rail is narrow and only the mark shows (the name stays for screen
   * readers).
   */
  kind?: 'header' | 'rail';
  /** The rail's version line, e.g. "Version 0.12.0". */
  version?: string;
  /** Render the name as the page's `h1` (the popup, which has no other). */
  heading?: boolean;
}

/**
 * The mark and the product name (DESIGN.md A-brand): Geist 600 at `--text-6`, the mark lit
 * while casting, and in the wide rail the version line. It is not a link.
 * @param props - Component props
 * @param props.name - The product name
 * @param props.lit - Casting
 * @param props.kind - header or rail
 * @param props.version - The version line
 * @param props.heading - Render the name as the `h1`
 * @returns The brand block
 */
export function BrandBlock({
  name,
  lit = false,
  kind = 'header',
  version,
  heading = false,
}: BrandBlockProps): JSX.Element {
  const Name = heading ? 'h1' : 'p';
  return (
    <div class={cx(styles.brand, styles[kind])}>
      <span class={styles.mark}>
        <Mark lit={lit} />
      </span>
      <span class={styles.words}>
        <Name class={styles.name}>{name}</Name>
        {kind === 'rail' && version && <span class={cx(styles.version, 'num')}>{version}</span>}
      </span>
    </div>
  );
}
