import type { ComponentChildren, JSX } from 'preact';
import { useId } from 'preact/hooks';
import { Card } from '../Card';
import { SectionHeader } from '../SectionHeader';
import styles from './SettingsSection.module.css';

/** Props for {@link SettingsSection}. */
export interface SettingsSectionProps {
  /** The section's heading: "Appearance", "Audio". */
  title: string;
  /** One line under the heading, on what the section holds ("Kept on this device…"). */
  description?: ComponentChildren;
  /** The heading's level. Defaults to 2. */
  headingLevel?: 2 | 3 | 4;
  /** The element id, for a link to the section (`#about`). */
  id?: string;
  /**
   * The items, in order: SettingsRows and Switches (which share the section's tracks), and
   * blocks that span them (a ChoiceGroup, a Notice, a DescriptionList, a Disclosure, a
   * SetList). An `h3` item is a subheading for the items after it; a `p` item is help for the
   * item before it.
   */
  children: ComponentChildren;
}

/**
 * A titled group of settings (DESIGN.md C-section): a Card named by its SectionHeader, an
 * optional line under the heading, then the items, which are one settings grid (F-grid).
 * From a 25rem card every row subgrids it: a label track and one `auto` control track for
 * every row, and from 45rem a help track, so every control ends on one edge and the help
 * starts at one edge; anything that is not a row spans the tracks. Under 25rem each row keeps
 * its own tracks. A hairline rule (`--divider`) divides each item from the one before it;
 * none sits under the heading, none runs round a Notice (a tinted block needs no line), and
 * none parts a subheading from what it heads or help from what it explains. In a section
 * every action row's Button fills the shared control track, so action Buttons are as wide as
 * the widest. A Disclosure's panel is a grid of its own with the same tracks, its rows
 * divided the same way.
 * @param props - Component props
 * @param props.title - The heading
 * @param props.description - A line under the heading
 * @param props.headingLevel - The heading's level
 * @param props.id - The element id
 * @param props.children - The items
 * @returns The section
 */
export function SettingsSection({
  title,
  description,
  headingLevel = 2,
  id,
  children,
}: SettingsSectionProps): JSX.Element {
  const headingId = useId();
  return (
    <Card id={id} labelledBy={headingId}>
      <div class={styles.head}>
        <SectionHeader kind="card" level={headingLevel} title={title} id={headingId} />
        {description && <p class={styles.description}>{description}</p>}
      </div>
      <div class={styles.items} data-settings-grid="section">
        {children}
      </div>
    </Card>
  );
}
