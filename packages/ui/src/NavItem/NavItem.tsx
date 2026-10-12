import type { JSX } from 'preact';
import { Icon } from '../Icon';
import type { GlyphName } from '../Icon/glyphs';
import { Tooltip } from '../Tooltip';
import { cx, dataAttributes, type DataAttributes } from '../utils/cx';
import { usePress } from '../utils/press';
import styles from './NavItem.module.css';

/** Props for {@link NavItem}. */
export interface NavItemProps extends DataAttributes {
  /** The glyph. */
  icon: GlyphName;
  /** The words; in the narrow rail they are the Tooltip and the accessible name. */
  label: string;
  /** The destination. */
  href: string;
  /** The page shown now: the primary container, a 2 px primary edge, `aria-current`. */
  current?: boolean;
  /** Disabled. */
  disabled?: boolean;
  /** Client-side routing: called instead of following the link (it prevents the default). */
  onNavigate?: (href: string) => void;
}

/**
 * One destination in the Rail (DESIGN.md A-nav): `--size-nav` tall, a glyph and its words.
 * Current is calm: the primary container, a 2 px primary inset edge and the strong weight,
 * so never colour alone. Under a 45rem window the rail is narrow: the item is a
 * `--size-nav` square and its words show in a Tooltip; the same container query that hides
 * the words shows the Tooltip, so nothing reads layout from script.
 * @param props - Component props
 * @param props.icon - The glyph
 * @param props.label - The words
 * @param props.href - The destination
 * @param props.current - The page shown now
 * @param props.disabled - Disabled
 * @param props.onNavigate - Client-side routing
 * @returns The link
 */
export function NavItem({
  icon,
  label,
  href,
  current = false,
  disabled = false,
  onNavigate,
  ...rest
}: NavItemProps): JSX.Element {
  const press = usePress(['enter']);
  return (
    <Tooltip content={label} block class={styles.tipHost}>
      <a
        class={cx(styles.item, disabled && styles.disabled)}
        href={disabled ? undefined : href}
        aria-current={current ? 'page' : undefined}
        aria-disabled={disabled ? 'true' : undefined}
        onClick={(event) => {
          if (disabled) {
            event.preventDefault();
            return;
          }
          if (onNavigate && !event.defaultPrevented && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            onNavigate(href);
          }
        }}
        {...press}
        {...dataAttributes(rest)}
      >
        <Icon glyph={icon} />
        <span class={styles.label}>{label}</span>
      </a>
    </Tooltip>
  );
}
