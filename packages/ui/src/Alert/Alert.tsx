import type { ComponentChildren, FunctionComponent } from 'preact';
import type { LucideProps } from 'lucide-preact';
import { AlertTriangle, CircleAlert, CircleCheck, Info, X } from 'lucide-preact';
import { IconButton } from '../IconButton';

type AlertVariant = 'warning' | 'error' | 'success' | 'info';

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
  success: 'alertSuccess',
  info: 'alertInfo',
};

const VARIANT_ICONS: Record<AlertVariant, FunctionComponent<LucideProps>> = {
  warning: AlertTriangle,
  error: CircleAlert,
  success: CircleCheck,
  info: Info,
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
  const Icon = VARIANT_ICONS[variant];

  return (
    <div className={`alert ${variantClass} ${className || ''}`} role="alert">
      <Icon size={16} className="alertIcon" aria-hidden="true" />
      <div className="alertContent">{children}</div>
      {onDismiss && (
        <IconButton size="sm" className="alertDismiss" onClick={onDismiss} aria-label="Dismiss">
          <X size={14} />
        </IconButton>
      )}
    </div>
  );
}
