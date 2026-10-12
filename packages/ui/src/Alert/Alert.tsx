import type { ComponentChildren } from 'preact';
import { Button } from '../Button';
import { Icon } from '../Icon';
import type { GlyphName } from '../Icon/glyphs';
import { IconButton } from '../IconButton';
import { cx } from '../utils/cx';
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
  /** Accessible label for the dismiss button (default: "Dismiss"), for translated UIs. */
  dismissLabel?: string;
  /** Action button label. If provided along with onAction, shows an inline action button. */
  action?: string;
  /** Callback when action button is clicked */
  onAction?: () => void;
}

const VARIANT_GLYPHS: Record<AlertVariant, GlyphName> = {
  warning: 'warning',
  error: 'danger',
  success: 'check',
  info: 'info',
};

/**
 * Shared Alert component for displaying important messages.
 *
 * @deprecated Phase 2 replaces it with Notice and NoticeLine (DESIGN.md §14). Until then it
 * draws the v1 status sets, glyphs, an outline Button action and an IconButton dismiss.
 * @param props - Component props
 * @param props.children - Alert content
 * @param props.variant - Visual variant (default: warning)
 * @param props.className - Additional CSS class
 * @param props.onDismiss - Callback when dismiss button is clicked
 * @param props.dismissLabel - Accessible label for the dismiss button
 * @param props.action - Action button label
 * @param props.onAction - Callback when action button is clicked
 * @returns The rendered Alert component
 */
export function Alert({
  children,
  variant = 'warning',
  className,
  onDismiss,
  dismissLabel = 'Dismiss',
  action,
  onAction,
}: AlertProps) {
  return (
    <div class={cx(styles.alert, styles[variant], className)} role="alert">
      <span class={styles.icon}>
        <Icon glyph={VARIANT_GLYPHS[variant]} />
      </span>
      <div class={styles.content}>
        <div class={styles.text}>{children}</div>
        {action && onAction && (
          <span class={styles.action}>
            <Button kind="outline" size="sm" onClick={onAction}>
              {action}
            </Button>
          </span>
        )}
      </div>
      {onDismiss && (
        <span class={styles.dismiss}>
          <IconButton glyph="x" label={dismissLabel} size="sm" onPress={onDismiss} />
        </span>
      )}
    </div>
  );
}
