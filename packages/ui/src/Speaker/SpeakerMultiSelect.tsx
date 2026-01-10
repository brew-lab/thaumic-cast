import styles from './SpeakerMultiSelect.module.css';

/**
 * Minimal interface for speaker groups.
 * Compatible with both protocol ZoneGroup and domain SpeakerGroup types.
 */
export interface SpeakerGroupLike {
  /** The coordinator speaker's IP address */
  coordinatorIp: string;
  /** Display name for the group */
  name: string;
}

interface SpeakerMultiSelectProps<T extends SpeakerGroupLike> {
  /** Array of available speaker groups */
  groups: readonly T[];
  /** Array of currently selected speaker/coordinator IPs */
  selectedIps: string[];
  /** Callback when selection changes */
  onSelectionChange: (ips: string[]) => void;
  /** Whether the control is disabled */
  disabled?: boolean;
  /** Label for the control */
  label?: string;
  /** Function to get display name for a group */
  getGroupDisplayName: (group: T) => string;
}

/**
 * Multiple speaker selection component.
 * Allows users to select one or more speaker groups from a list.
 *
 * @param props - Component props
 * @param props.groups
 * @param props.selectedIps
 * @param props.onSelectionChange
 * @param props.disabled
 * @param props.label
 * @param props.getGroupDisplayName
 * @returns The rendered SpeakerMultiSelect component
 */
export function SpeakerMultiSelect<T extends SpeakerGroupLike>({
  groups,
  selectedIps,
  onSelectionChange,
  disabled = false,
  label,
  getGroupDisplayName,
}: SpeakerMultiSelectProps<T>) {
  const toggleSpeaker = (ip: string) => {
    if (selectedIps.includes(ip)) {
      onSelectionChange(selectedIps.filter((selectedIp) => selectedIp !== ip));
    } else {
      onSelectionChange([...selectedIps, ip]);
    }
  };

  return (
    <fieldset className={styles.container} disabled={disabled}>
      {label && <legend className={styles.label}>{label}</legend>}
      <ul className={styles.list}>
        {groups.map((group) => {
          const isSelected = selectedIps.includes(group.coordinatorIp);
          const displayName = getGroupDisplayName(group);
          return (
            <li key={group.coordinatorIp} className={styles.itemWrapper}>
              <label
                className={[styles.item, isSelected && styles.selected, disabled && styles.disabled]
                  .filter(Boolean)
                  .join(' ')}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  disabled={disabled}
                  onChange={() => toggleSpeaker(group.coordinatorIp)}
                  className={styles.checkbox}
                />
                <span className={styles.name}>{displayName}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
