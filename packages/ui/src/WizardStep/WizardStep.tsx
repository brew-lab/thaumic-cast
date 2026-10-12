import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { Artwork } from '../Artwork';
import type { GlyphName } from '../Icon/glyphs';
import styles from './WizardStep.module.css';

/** Props for {@link WizardStep}. */
export interface WizardStepProps {
  /** The step's title, its `h2`: "The companion". */
  title: string;
  /** One line under the title: "The half that talks to the speakers". */
  subtitle?: string;
  /** The step's glyph, drawn as a disc Artwork (cast, monitor, speaker, check, puzzle…). */
  glyph?: GlyphName;
  /** The title's id; the Wizard names its dialog with it. An empty string gives none. */
  titleId?: string;
  /** The subtitle's id; the Wizard describes its dialog with it. An empty string gives none. */
  subtitleId?: string;
  /** The step's body. */
  children: ComponentChildren;
}

/**
 * One step of a Wizard (DESIGN.md M-wizardstep): a disc Artwork beside the step's `h2` and
 * subtitle, then the body. On a step change focus moves to the `h2`, so a screen reader
 * hears the new step; when the wizard first opens, focus is left where it is.
 * @param props - Component props
 * @param props.title - The step's title
 * @param props.subtitle - A line under the title
 * @param props.glyph - The disc's glyph
 * @param props.titleId - The title's id
 * @param props.subtitleId - The subtitle's id
 * @param props.children - The body
 * @returns The step
 */
export function WizardStep({
  title,
  subtitle,
  glyph,
  titleId = 'wizard-title',
  subtitleId = 'wizard-description',
  children,
}: WizardStepProps): JSX.Element {
  const heading = useRef<HTMLHeadingElement>(null);

  // A step that mounts while something in the page has focus is a step change (Next, Back,
  // Skip): move focus to its heading. On first open nothing has focus yet.
  useEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body) heading.current?.focus();
  }, []);

  return (
    <div class={styles.step}>
      <div class={styles.header}>
        {glyph && <Artwork kind="disc" size="lg" glyph={glyph} />}
        <div class={styles.titles}>
          <h2 ref={heading} id={titleId || undefined} class={styles.title} tabIndex={-1}>
            {title}
          </h2>
          {subtitle && (
            <p id={subtitleId || undefined} class={styles.subtitle}>
              {subtitle}
            </p>
          )}
        </div>
      </div>
      <div class={styles.body}>{children}</div>
    </div>
  );
}
