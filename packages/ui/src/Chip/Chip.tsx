import type { JSX } from 'preact';
import { Icon } from '../Icon';
import { cx, dataAttributes, type DataAttributes } from '../utils/cx';
import styles from './Chip.module.css';

/** Props for {@link Chip}. */
export interface ChipProps extends DataAttributes {
  /** The words, e.g. an address. */
  label: string;
  /** Machine text (an address): `.mono`, left to right. */
  mono?: boolean;
  /** Removes the chip. */
  onRemove: () => void;
  /** The remove button's name: "Remove 192.168.1.47". */
  removeLabel: string;
  /** Disabled, e.g. while a removal is in flight. */
  disabled?: boolean;
}

/**
 * Moves focus to the next chip's remove button after one is removed, or to the previous
 * one when it was the last (DESIGN.md A-chip).
 * @param from - The remove button that was used
 */
function focusNeighbour(from: HTMLElement): void {
  const chip = from.closest('[data-chip]');
  let scope = chip?.parentElement ?? null;
  while (scope && scope !== document.body && scope.querySelectorAll('[data-chip]').length < 2) {
    scope = scope.parentElement;
  }
  if (!scope) return;
  const buttons = [...scope.querySelectorAll<HTMLButtonElement>('[data-chip] button')];
  const at = buttons.indexOf(from as HTMLButtonElement);
  const next = buttons[at + 1] ?? buttons[at - 1];
  if (next) requestAnimationFrame(() => next.focus());
}

/**
 * A removable value (DESIGN.md A-chip), input kind only: the desktop's speakers added by
 * address. The × is a 1.5rem square with the small bevel on hover and focus, and its hit
 * area grows to the desktop target. Focus rings the whole chip on its unchanged corner.
 * Delete or Backspace removes the chip and moves focus to the next one.
 * @param props - Component props
 * @param props.label - The words
 * @param props.mono - Machine text
 * @param props.onRemove - Removes the chip
 * @param props.removeLabel - The remove button's name
 * @param props.disabled - Disabled
 * @returns The chip
 */
export function Chip({
  label,
  mono = false,
  onRemove,
  removeLabel,
  disabled = false,
  ...rest
}: ChipProps): JSX.Element {
  const remove = (button: HTMLElement): void => {
    focusNeighbour(button);
    onRemove();
  };
  return (
    <span class={styles.chip} data-chip="" {...dataAttributes(rest)}>
      <span class={cx(styles.label, mono && 'mono')}>{label}</span>
      <button
        type="button"
        class={styles.remove}
        aria-label={removeLabel}
        disabled={disabled}
        onClick={(event) => remove(event.currentTarget as HTMLElement)}
        onKeyDown={(event) => {
          if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            remove(event.currentTarget as HTMLElement);
          }
        }}
      >
        <Icon glyph="x" />
      </button>
    </span>
  );
}
