import type { h, JSX } from 'preact';
import { forwardRef } from 'preact/compat';

export type IconButtonVariant = 'ghost' | 'outline' | 'danger';
export type IconButtonSize = 'sm' | 'md' | 'lg';

interface IconButtonProps extends Omit<h.JSX.HTMLAttributes<HTMLButtonElement>, 'size'> {
  /** Visual style variant */
  variant?: IconButtonVariant;
  /** Button size */
  size?: IconButtonSize;
  /** Whether the button is disabled */
  disabled?: boolean;
  /** Icon element to render */
  children: JSX.Element;
}

/**
 * Icon-only button component with consistent styling.
 * @param props - Component props
 * @param props.variant - Visual variant ('ghost', 'outline', 'danger')
 * @param props.size - Button size ('sm', 'md', 'lg')
 * @param props.disabled - Whether the button is disabled
 * @param props.children - Icon element to render
 * @param props.className - Additional CSS class
 * @returns The rendered IconButton component
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = 'ghost', size = 'md', className, children, ...props },
  ref,
) {
  const sizeClass = size === 'sm' ? 'iconBtnSm' : size === 'lg' ? 'iconBtnLg' : 'iconBtnMd';
  const variantClass =
    variant === 'outline'
      ? 'iconBtnOutline'
      : variant === 'danger'
        ? 'iconBtnDanger'
        : 'iconBtnGhost';
  const combinedClass = `iconBtn ${sizeClass} ${variantClass} ${className || ''}`.trim();

  return (
    <button ref={ref} type="button" className={combinedClass} {...props}>
      {children}
    </button>
  );
});
