import type { JSX } from 'preact';
import { BrandBlock } from '../BrandBlock';
import type { GlyphName } from '../Icon';
import { NavItem } from '../NavItem';
import styles from './Rail.module.css';

/** One destination in a {@link Rail}. */
export interface RailItem {
  /** The route: "/", "/server". */
  href: string;
  /** Its glyph. */
  icon: GlyphName;
  /** Its words, and its Tooltip in the narrow rail. */
  label: string;
}

/** Props for {@link Rail}. */
export interface RailProps {
  /** The brand: the app's name, the version (wide rail only) and whether the mark is lit. */
  brand: { name: string; version?: string; lit?: boolean };
  /** The destinations, in order. */
  items: RailItem[];
  /** The current route; the item with this `href` is current. */
  current: string;
  /** Client-side routing: called with an item's `href` instead of loading it. */
  onNavigate?: (href: string) => void;
  /** The navigation's name. */
  navLabel: string;
}

/**
 * The desktop's rail (DESIGN.md C-rail): the BrandBlock (lit while a cast plays, the version
 * under the name in the wide rail) and a `<nav>` of NavItems, on `--container`. Its width is
 * the DesktopShell's: `--rail-narrow` under a 45rem window, `--rail-wide` from it; in the
 * narrow rail the BrandBlock is the mark alone and each NavItem shows its words in a Tooltip
 * (their own container queries on the window, so nothing reads layout from script).
 * @param props - Component props
 * @param props.brand - The brand
 * @param props.items - The destinations
 * @param props.current - The current route
 * @param props.onNavigate - Client-side routing
 * @param props.navLabel - The navigation's name
 * @returns The rail
 */
export function Rail({ brand, items, current, onNavigate, navLabel }: RailProps): JSX.Element {
  return (
    <aside class={styles.rail} data-rail="">
      <div class={styles.brand}>
        <BrandBlock name={brand.name} kind="rail" lit={brand.lit} version={brand.version} />
      </div>
      <nav class={styles.nav} aria-label={navLabel}>
        {items.map(({ href, icon, label }) => (
          <NavItem
            key={href}
            href={href}
            icon={icon}
            label={label}
            current={current === href}
            onNavigate={onNavigate}
          />
        ))}
      </nav>
    </aside>
  );
}
