import { h } from 'preact';
import styles from './IconButton.module.css';

interface IconButtonProps extends h.JSX.HTMLAttributes<HTMLButtonElement> {
  /** Button size */
  size?: 'sm' | 'md' | 'lg';
  /** Visual variant */
  variant?: 'ghost' | 'solid' | 'outline' | 'danger';
  /** Whether the button is disabled */
  disabled?: boolean;
}

/**
 * Shared Icon Button Component
 *
 * @param props - Standard HTML button props + size/variant
 * @param props.size - Button size (default: md)
 * @param props.variant - Visual variant (default: ghost)
 * @param props.className - Additional CSS class
 * @param props.disabled - Whether the button is disabled
 * @returns The rendered IconButton component
 */
export function IconButton({
  size = 'md',
  variant = 'ghost',
  className,
  disabled,
  ...props
}: IconButtonProps) {
  const sizeClass = size === 'sm' ? styles.sm : size === 'lg' ? styles.lg : styles.md;
  const variantClass =
    variant === 'solid'
      ? styles.solid
      : variant === 'outline'
        ? styles.outline
        : variant === 'danger'
          ? styles.danger
          : styles.ghost;
  const combinedClass = [styles.iconBtn, sizeClass, variantClass, className]
    .filter(Boolean)
    .join(' ');

  return <button {...props} disabled={disabled} className={combinedClass} />;
}
