import type { ComponentChildren, FunctionComponent } from 'preact';
import type { LucideProps } from 'lucide-preact';
import { AlertTriangle, CircleAlert, CircleCheck, Info, X } from 'lucide-preact';
import { IconButton } from '../IconButton';
import styles from './Alert.module.css';

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
  warning: styles.warning,
  error: styles.error,
  success: styles.success,
  info: styles.info,
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
    <div className={[styles.alert, variantClass, className].filter(Boolean).join(' ')} role="alert">
      <Icon size={16} className={styles.icon} aria-hidden="true" />
      <div className={styles.content}>{children}</div>
      {onDismiss && (
        <IconButton size="sm" className={styles.dismiss} onClick={onDismiss} aria-label="Dismiss">
          <X size={14} />
        </IconButton>
      )}
    </div>
  );
}
