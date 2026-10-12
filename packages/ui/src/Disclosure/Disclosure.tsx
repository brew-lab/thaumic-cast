import type { ComponentChildren, JSX } from 'preact';
import { Icon } from '../Icon';
import { cx, dataAttributes, type DataAttributes } from '../utils/cx';
import styles from './Disclosure.module.css';

/** Props for {@link Disclosure}. */
export interface DisclosureProps extends DataAttributes {
  /** The trigger's name: "Advanced", "Enter the address yourself". It never truncates. */
  label: string;
  /** A one-line summary after the label, which truncates first ("Kitchen 30 · Patio 46"). */
  summary?: string;
  /** Open, when the caller holds the state (the popup remembers the rooms fold). */
  open?: boolean;
  /** Open at first, when the Disclosure holds its own state. */
  defaultOpen?: boolean;
  /** Called with the new state when the user opens or shuts it. */
  onOpenChange?: (open: boolean) => void;
  /**
   * sm (the default) is 32 on every surface; md is 36 in the popup and 44 in a window, for a
   * fold that is a row of a popup list (F-size).
   */
  size?: 'sm' | 'md';
  /** Disabled: 38 %, and it does not open or shut. */
  disabled?: boolean;
  /** The element id, for a link that opens it (`#audio-advanced`). */
  id?: string;
  /** The panel, shown while open. */
  children: ComponentChildren;
}

/**
 * Long content folded in place (DESIGN.md M-disclosure, P-fold): always `<details>` and
 * `<summary>`, so the expanded state, Enter and Space are native and nothing in a shut panel
 * is focusable or read out. The trigger is quiet: a chevron that turns, the label in 600 and
 * an optional summary that truncates before the label does. It follows the grammar as a wide
 * control (the bevel on hover and focus, the wide press); open is not a selected state. The
 * trigger bleeds its padding past the content edge, so the chevron lines up with the text
 * above. Its size, not the density, sets its height; the hit area reaches 44 on a window.
 * @param props - Component props
 * @param props.label - The trigger's name
 * @param props.summary - A summary after the label
 * @param props.open - Open, when the caller holds the state
 * @param props.defaultOpen - Open at first
 * @param props.onOpenChange - Called with the new state
 * @param props.size - sm or md
 * @param props.disabled - Disabled
 * @param props.id - The element id
 * @param props.children - The panel
 * @returns The disclosure
 */
export function Disclosure({
  label,
  summary,
  open,
  defaultOpen = false,
  onOpenChange,
  size = 'sm',
  disabled = false,
  id,
  children,
  ...rest
}: DisclosureProps): JSX.Element {
  return (
    <details
      id={id}
      class={cx(styles.disclosure, styles[size], disabled && styles.disabled)}
      data-size={size}
      open={open ?? defaultOpen}
      onToggle={(event) => {
        const now = (event.currentTarget as HTMLDetailsElement).open;
        if (now !== open) onOpenChange?.(now);
      }}
    >
      <summary
        class={styles.trigger}
        aria-disabled={disabled ? 'true' : undefined}
        onClick={(event) => {
          if (disabled) event.preventDefault();
        }}
        {...dataAttributes(rest)}
      >
        <span class={styles.chevron}>
          <Icon glyph="chevron-down" />
        </span>
        <span class={styles.label}>{label}</span>
        {summary && <span class={cx(styles.summary, 'num')}>{summary}</span>}
      </summary>
      <div class={styles.panel}>{children}</div>
    </details>
  );
}
