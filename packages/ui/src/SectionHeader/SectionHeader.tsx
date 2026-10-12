import type { ComponentChildren, JSX } from 'preact';
import { cx } from '../utils/cx';
import styles from './SectionHeader.module.css';

/** Props for {@link SectionHeader}. */
export interface SectionHeaderProps {
  /** card: heads a Card or a SettingsSection; live: "Casting now", once per screen. */
  kind?: 'card' | 'live';
  /** The heading level. */
  level: 2 | 3 | 4;
  /** The heading. */
  title: string;
  /** A short line beside the heading, outside it ("2 casting"). */
  meta?: string;
  /** Actions at the end; they drop under the heading when there is no room. */
  actions?: ComponentChildren;
  /** The heading's id, for `aria-labelledby` on the section it heads. */
  id?: string;
}

/**
 * The heading of a Card or a section (DESIGN.md A-heading). card is Geist 600 at
 * `--text-5`, in the brand ink in light; live is "Casting now" at `--text-7` in the live
 * gradient, with a solid colour under forced colours. Every page title is a PageHeader, so
 * there is no page kind. It is static; its actions follow Button.
 * @param props - Component props
 * @param props.kind - card or live
 * @param props.level - The heading level
 * @param props.title - The heading
 * @param props.meta - A line beside the heading
 * @param props.actions - Actions at the end
 * @param props.id - The heading's id
 * @returns The header
 */
export function SectionHeader({
  kind = 'card',
  level,
  title,
  meta,
  actions,
  id,
}: SectionHeaderProps): JSX.Element {
  const Heading = `h${level}` as 'h2';
  return (
    <div class={cx(styles.header, styles[kind])}>
      <Heading id={id} class={styles.title}>
        {kind === 'live' ? <span class={styles.gradient}>{title}</span> : title}
      </Heading>
      {meta && <p class={styles.meta}>{meta}</p>}
      {actions && <div class={styles.actions}>{actions}</div>}
    </div>
  );
}
