import { h } from 'preact';
import styles from './ToggleSwitch.module.css';

interface ToggleSwitchProps extends Omit<
  h.JSX.HTMLAttributes<HTMLButtonElement>,
  'onChange' | 'aria-label'
> {
  /** Current state */
  checked: boolean;
  /** Callback when state changes */
  onChange: (checked: boolean) => void;
  /** Whether the switch is disabled */
  disabled?: boolean;
  /** Accessible label describing what the switch controls (required for WCAG 4.1.2) */
  'aria-label': string;
}

/**
 * Switch component for toggling binary states.
 * @param props - Component props
 * @param props.checked - Current state
 * @param props.onChange - State change handler
 * @param props.disabled - Whether disabled
 * @param props.aria-label - Accessible label (required)
 * @param props.className - Additional CSS class
 * @returns The rendered ToggleSwitch component
 */
export function ToggleSwitch({
  checked,
  onChange,
  disabled,
  className,
  'aria-label': ariaLabel,
  ...props
}: ToggleSwitchProps) {
  const combinedClass = [
    styles.toggleSwitch,
    checked && styles.on,
    disabled && styles.disabled,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={combinedClass}
      onClick={() => !disabled && onChange(!checked)}
      {...props}
    >
      <span className={styles.thumb} aria-hidden="true" />
    </button>
  );
}
