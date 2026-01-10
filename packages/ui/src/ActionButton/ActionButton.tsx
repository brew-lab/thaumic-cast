import { Button } from '../Button';
import { Loader2, Check, X, LucideIcon } from 'lucide-preact';
import { useButtonAction } from '../hooks/useButtonAction';
import styles from './ActionButton.module.css';

interface ActionButtonProps {
  /** Async function to execute on click */
  action: () => Promise<void>;
  /** Label shown in idle state */
  label: string;
  /** Label shown during loading (optional, defaults to label) */
  loadingLabel?: string;
  /** Label shown on success (optional, falls back to label) */
  successLabel?: string;
  /** Label shown on error (optional, falls back to label) */
  errorLabel?: string;
  /** Icon component shown in idle state */
  icon: LucideIcon;
  /** Button variant */
  variant?: 'primary' | 'secondary' | 'danger';
  /** Additional CSS class */
  className?: string;
  /** Success state duration in ms */
  successDuration?: number;
  /** Error state duration in ms */
  errorDuration?: number;
  /** Minimum loading state duration in ms (default: 600) */
  minLoadingDuration?: number;
  /** Whether the button should take full width of its container */
  fullWidth?: boolean;
  /** Whether the button is disabled */
  disabled?: boolean;
}

/**
 * Button with built-in loading, success, and error states.
 *
 * Wraps Button with useButtonAction hook for consistent async feedback.
 *
 * @param props - Component props
 * @param props.action - Async function to execute on click
 * @param props.label - Default button label
 * @param props.loadingLabel - Label shown during loading
 * @param props.successLabel - Label shown on success
 * @param props.errorLabel - Label shown on error
 * @param props.icon - Icon component to display
 * @param props.variant - Button style variant
 * @param props.className - Additional CSS class
 * @param props.successDuration - Success state duration in ms
 * @param props.errorDuration - Error state duration in ms
 * @param props.minLoadingDuration - Minimum loading state duration in ms
 * @param props.fullWidth - Whether the button should take full width
 * @param props.disabled - Whether the button is disabled
 * @returns The rendered ActionButton component
 *
 * @example
 * ```tsx
 * <ActionButton
 *   action={() => restartServer()}
 *   label="Restart"
 *   loadingLabel="Restarting..."
 *   icon={RefreshCcw}
 *   variant="secondary"
 * />
 * ```
 */
export function ActionButton({
  action,
  label,
  loadingLabel,
  successLabel,
  errorLabel,
  icon: Icon,
  variant = 'primary',
  className,
  successDuration,
  errorDuration,
  minLoadingDuration,
  fullWidth,
  disabled,
}: ActionButtonProps) {
  const { status, isDisabled, execute } = useButtonAction(action, {
    successDuration,
    errorDuration,
    minLoadingDuration,
  });

  const getIcon = () => {
    switch (status) {
      case 'loading':
        return <Loader2 size={16} className={styles.spin} />;
      case 'success':
        return <Check size={16} />;
      case 'error':
        return <X size={16} />;
      default:
        return <Icon size={16} />;
    }
  };

  const getLabel = () => {
    switch (status) {
      case 'loading':
        return loadingLabel ?? label;
      case 'success':
        return successLabel ?? label;
      case 'error':
        return errorLabel ?? label;
      default:
        return label;
    }
  };

  const getVariant = (): 'primary' | 'secondary' | 'danger' => {
    if (status === 'error') return 'danger';
    if (status === 'success') return 'primary';
    return variant;
  };

  const statusClass =
    status === 'success' ? styles.success : status === 'error' ? styles.error : '';
  const combinedClass = [className, styles['action-button'], statusClass].filter(Boolean).join(' ');

  return (
    <Button
      variant={getVariant()}
      onClick={execute}
      disabled={disabled || isDisabled}
      className={combinedClass}
      fullWidth={fullWidth}
    >
      {getIcon()} {getLabel()}
    </Button>
  );
}
