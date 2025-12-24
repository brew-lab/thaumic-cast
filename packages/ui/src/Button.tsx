import { h } from 'preact';

interface ButtonProps extends h.JSX.HTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
}

/**
 * Shared Button Component
 *
 * @param props - Standard HTML button props + variant
 * @param props.variant - Button style variant
 * @param props.className - Additional CSS class
 * @param props.disabled - Whether the button is disabled
 * @returns The rendered Button component
 */
export function Button({ variant = 'primary', className, disabled, ...props }: ButtonProps) {
  const variantClass =
    variant === 'primary' ? 'btnPrimary' : variant === 'secondary' ? 'btnSecondary' : 'btnDanger';
  const combinedClass = `btn ${variantClass} ${className || ''}`;

  return <button {...props} disabled={disabled} className={combinedClass} />;
}
