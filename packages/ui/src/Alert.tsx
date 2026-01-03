import type { ComponentChildren } from 'preact';
import { AlertTriangle } from 'lucide-preact';

type AlertVariant = 'warning';

interface AlertProps {
  /** Alert content */
  children: ComponentChildren;
  /** Visual variant */
  variant?: AlertVariant;
  /** Additional CSS class */
  className?: string;
}

/**
 * Shared Alert component for displaying important messages.
 * @param props - Component props
 * @param props.children - Alert content
 * @param props.variant - Visual variant (default: warning)
 * @param props.className - Additional CSS class
 * @returns The rendered Alert component
 */
export function Alert({ children, variant = 'warning', className }: AlertProps) {
  const variantClass = variant === 'warning' ? 'alertWarning' : '';

  return (
    <div className={`alert ${variantClass} ${className || ''}`} role="alert">
      <AlertTriangle size={16} className="alertIcon" aria-hidden="true" />
      <div className="alertContent">{children}</div>
    </div>
  );
}
