import type { ComponentChildren, JSX } from 'preact';
import styles from './PageHeader.module.css';

/** Props for {@link PageHeader}. */
export interface PageHeaderProps {
  /** The page's title: "Rooms", "Settings". */
  title: string;
  /** One line under the title: "4 rooms, 2 casting". */
  summary?: string;
  /** Actions at the end, in a row; they drop under the title when there is no room. */
  actions?: ComponentChildren;
  /** The heading's id, for `aria-labelledby` on the page. */
  id?: string;
}

/**
 * Every page's title (DESIGN.md M-pageheader): an `h1` in Geist 600 at `--text-8` (the
 * brand ink in light), an optional summary and optional actions. The desktop views, Not
 * found and the options page ("Settings", no summary, no actions) all use it. It is static.
 * @param props - Component props
 * @param props.title - The page's title
 * @param props.summary - A line under the title
 * @param props.actions - Actions at the end
 * @param props.id - The heading's id
 * @returns The header
 */
export function PageHeader({ title, summary, actions, id }: PageHeaderProps): JSX.Element {
  return (
    <header class={styles.header}>
      <div class={styles.titles}>
        <h1 id={id} class={styles.title}>
          {title}
        </h1>
        {summary && <p class={styles.summary}>{summary}</p>}
      </div>
      {actions && <div class={styles.actions}>{actions}</div>}
    </header>
  );
}
