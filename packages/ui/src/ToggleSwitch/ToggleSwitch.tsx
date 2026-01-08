import type { JSX } from 'preact';
import { useCallback } from 'preact/hooks';

interface ToggleSwitchProps {
  /** Whether the switch is on */
  checked: boolean;
  /** Callback when the switch is toggled */
  onChange: (checked: boolean) => void;
  /** Accessible label for the switch */
  'aria-label': string;
  /** Whether the switch is disabled */
  disabled?: boolean;
  /** Additional CSS class */
  className?: string;
}

/**
 * Accessible toggle switch component.
 * Uses role="switch" with proper ARIA attributes.
 * @param props - Component props
 * @param props.checked - Whether the switch is on
 * @param props.onChange - Callback when toggled
 * @param props.aria-label - Accessible label
 * @param props.disabled - Whether disabled
 * @param props.className - Additional CSS class
 * @returns The rendered ToggleSwitch component
 */
export function ToggleSwitch({
  checked,
  onChange,
  'aria-label': ariaLabel,
  disabled = false,
  className,
}: ToggleSwitchProps): JSX.Element {
  const handleClick = useCallback(() => {
    if (!disabled) {
      onChange(!checked);
    }
  }, [checked, disabled, onChange]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (disabled) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        onChange(!checked);
      }
    },
    [checked, disabled, onChange],
  );

  const combinedClass =
    `toggleSwitch ${checked ? 'toggleSwitchOn' : ''} ${disabled ? 'toggleSwitchDisabled' : ''} ${className || ''}`.trim();

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={combinedClass}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <span className="toggleSwitchThumb" aria-hidden="true" />
    </button>
  );
}
