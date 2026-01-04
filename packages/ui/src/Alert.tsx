import type { ComponentChildren } from 'preact';
import { AlertTriangle, X } from 'lucide-preact';
import { IconButton } from './IconButton';

type AlertVariant = 'warning' | 'error';

interface AlertProps {
  /** Alert content */
  children: ComponentChildren;
  /** Visual variant */
  variant?: AlertVariant;
  /** Additional CSS class */
  className?: string;
  /** Callback when dismiss button is clicked. If provided, shows a dismiss button. */
  onDismiss?: () => void;
}

const VARIANT_CLASSES: Record<AlertVariant, string> = {
  warning: 'alertWarning',
  error: 'alertError',
};

/**
 * Shared Alert component for displaying important messages.
 * @param props - Component props
 * @param props.children - Alert content
 * @param props.variant - Visual variant (default: warning)
 * @param props.className - Additional CSS class
 * @param props.onDismiss - Callback when dismiss button is clicked
 * @returns The rendered Alert component
 */
export function Alert({ children, variant = 'warning', className, onDismiss }: AlertProps) {
  const variantClass = VARIANT_CLASSES[variant];

  return (
    <div className={`alert ${variantClass} ${className || ''}`} role="alert">
      <AlertTriangle size={16} className="alertIcon" aria-hidden="true" />
      <div className="alertContent">{children}</div>
      {onDismiss && (
        <IconButton size="sm" className="alertDismiss" onClick={onDismiss} aria-label="Dismiss">
          <X size={14} />
        </IconButton>
      )}
    </div>
  );
}
