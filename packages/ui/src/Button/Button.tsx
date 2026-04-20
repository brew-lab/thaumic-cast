import { h } from 'preact';
import styles from './Button.module.css';

interface ButtonProps extends h.JSX.HTMLAttributes<HTMLButtonElement> {
  /**
   * Button style variant.
   * - `primary`/`secondary`/`danger`: standard solid buttons.
   * - `link`: borderless, padding-less, underlined text — for inline calls
   *   to action that should sit alongside other text without dominating it.
   */
  variant?: 'primary' | 'secondary' | 'danger' | 'link';
  /** Whether the button is disabled */
  disabled?: boolean;
  /** Whether the button should take full width of its container */
  fullWidth?: boolean;
}

/**
 * Shared Button Component
 *
 * @param props - Standard HTML button props + variant
 * @param props.variant - Button style variant
 * @param props.className - Additional CSS class
 * @param props.disabled - Whether the button is disabled
 * @param props.fullWidth - Whether the button should take full width
 * @returns The rendered Button component
 */
export function Button({
  variant = 'primary',
  className,
  disabled,
  fullWidth,
  ...props
}: ButtonProps) {
  const variantClass =
    variant === 'primary'
      ? styles.primary
      : variant === 'secondary'
        ? styles.secondary
        : variant === 'link'
          ? styles.link
          : styles.danger;
  const widthClass = fullWidth ? styles.fullWidth : '';
  const combinedClass = [styles.btn, variantClass, widthClass, className].filter(Boolean).join(' ');

  return <button {...props} disabled={disabled} className={combinedClass} />;
}
