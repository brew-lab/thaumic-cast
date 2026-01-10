import type { ComponentChildren, ComponentType } from 'preact';
import styles from './Wizard.module.css';

interface WizardStepProps {
  /** Step title */
  title: string;
  /** Optional subtitle/description */
  subtitle?: string;
  /** Icon component (e.g., from lucide-preact) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon?: ComponentType<any>;
  /** Step content */
  children: ComponentChildren;
}

/**
 * A single step within a Wizard.
 * Provides consistent layout with title, subtitle, icon, and content area.
 *
 * @param props - Step configuration
 * @param props.title
 * @param props.subtitle
 * @param props.icon
 * @param props.children
 * @returns The rendered WizardStep component
 */
export function WizardStep({
  title,
  subtitle,
  icon: Icon,
  children,
}: WizardStepProps): preact.JSX.Element {
  return (
    <div className={styles.step}>
      <div className={styles['step-header']}>
        {Icon && (
          <div className={styles['step-icon']}>
            <Icon size={32} />
          </div>
        )}
        <h2 className={styles['step-title']} id="wizard-title">
          {title}
        </h2>
        {subtitle && (
          <p className={styles['step-subtitle']} id="wizard-description">
            {subtitle}
          </p>
        )}
      </div>
      <div className={styles['step-content']}>{children}</div>
    </div>
  );
}
