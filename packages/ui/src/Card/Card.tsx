import type { ComponentChildren, JSX } from 'preact';
import { useId } from 'preact/hooks';
import { SectionHeader } from '../SectionHeader';
import { cx } from '../utils/cx';
import styles from './Card.module.css';

/** Props for {@link Card}. */
export interface CardProps {
  /** The heading, a SectionHeader of kind `card`. A card with one is a named `<section>`. */
  title?: string;
  /** The heading's level. Defaults to 2. */
  level?: 2 | 3 | 4;
  /** A short line beside the heading. */
  meta?: string;
  /** Actions at the end of the heading. */
  actions?: ComponentChildren;
  /**
   * No padding, for a card that lays out its own edge (a cast, a room). Nothing is clipped,
   * so focus rings stay whole; a part that paints to the edge rounds its own corners.
   */
  flush?: boolean;
  /** The element id, for a link to the card (`#speakers`). */
  id?: string;
  /** Names the card when it has no heading. */
  'aria-label'?: string;
  /**
   * The id of a heading inside the content that names the card (a TabCard or CastTile is
   * named by its media title): the card is then a `<section>` without a SectionHeader.
   */
  labelledBy?: string;
  /** The content. */
  children: ComponentChildren;
}

/**
 * The one container (DESIGN.md C-card): `--radius-card`, `--surface`, a hairline in light
 * only (in dark the surface step is the edge), and no shadow; there is no raised kind. It is
 * the `card` container its contents lay out from, and it points the focus ring's gap at its
 * surface. With a title it is a `<section>` named by a SectionHeader; without one, a plain
 * box. The density sets the padding: 12 in the popup, `--space-5` on the desktop. Its body is
 * the settings grid: settings rows and Switches placed in it share one control column.
 * @param props - Component props
 * @param props.title - The heading
 * @param props.level - The heading's level
 * @param props.meta - A line beside the heading
 * @param props.actions - Actions at the end of the heading
 * @param props.flush - No padding
 * @param props.id - The element id
 * @param props.labelledBy - The id of the element inside that names it
 * @param props.children - The content
 * @returns The card
 */
export function Card({
  title,
  level = 2,
  meta,
  actions,
  flush = false,
  id,
  labelledBy,
  children,
  ...rest
}: CardProps): JSX.Element {
  const headingId = useId();
  const className = cx(styles.card, flush && styles.flush);
  const body = <div class={styles.body}>{children}</div>;
  if (!title && labelledBy) {
    return (
      <section id={id} class={className} aria-labelledby={labelledBy}>
        {body}
      </section>
    );
  }
  if (!title) {
    return (
      <div id={id} class={className} aria-label={rest['aria-label']}>
        {body}
      </div>
    );
  }
  return (
    <section id={id} class={className} aria-labelledby={headingId}>
      <SectionHeader
        kind="card"
        level={level}
        title={title}
        meta={meta}
        actions={actions}
        id={headingId}
      />
      {body}
    </section>
  );
}
