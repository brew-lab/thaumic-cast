import type { ComponentChildren } from 'preact';
import { Artwork } from '../Artwork';
import type { GlyphName } from '../Icon/glyphs';
import styles from './Wizard.module.css';

interface WizardStepProps {
  /** Step title */
  title: string;
  /** Optional subtitle/description */
  subtitle?: string;
  /** The step's glyph, drawn as a large disc Artwork */
  glyph?: GlyphName;
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
 * @param props.glyph
 * @param props.children
 * @returns The rendered WizardStep component
 */
export function WizardStep({
  title,
  subtitle,
  glyph,
  children,
}: WizardStepProps): preact.JSX.Element {
  return (
    <div className={styles.step}>
      <div className={styles.stepHeader}>
        {glyph && <Artwork kind="disc" size="lg" glyph={glyph} />}
        <h2 className={styles.stepTitle} id="wizard-title">
          {title}
        </h2>
        {subtitle && (
          <p className={styles.stepSubtitle} id="wizard-description">
            {subtitle}
          </p>
        )}
      </div>
      <div className={styles.stepContent}>{children}</div>
    </div>
  );
}
