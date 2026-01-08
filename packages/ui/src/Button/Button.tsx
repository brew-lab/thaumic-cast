import { h } from 'preact';

interface ButtonProps extends h.JSX.HTMLAttributes<HTMLButtonElement> {
  /** Button style variant */
  variant?: 'primary' | 'secondary' | 'danger';
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
    variant === 'primary' ? 'btnPrimary' : variant === 'secondary' ? 'btnSecondary' : 'btnDanger';
  const widthClass = fullWidth ? 'btnFullWidth' : '';
  const combinedClass = `btn ${variantClass} ${widthClass} ${className || ''}`.trim();

  return <button {...props} disabled={disabled} className={combinedClass} />;
}
