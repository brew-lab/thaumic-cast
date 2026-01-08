import type { ZoneGroup } from '@thaumic-cast/protocol';
import styles from './SpeakerMultiSelect.module.css';

interface SpeakerMultiSelectProps {
  /** Array of available speaker groups */
  groups: ZoneGroup[];
  /** Array of currently selected speaker/coordinator IPs */
  selectedIps: string[];
  /** Callback when selection changes */
  onSelectionChange: (ips: string[]) => void;
  /** Whether the control is disabled */
  disabled?: boolean;
  /** Label for the control */
  label?: string;
  /** Function to get display name for a group */
  getGroupDisplayName: (group: ZoneGroup) => string;
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
export function SpeakerMultiSelect({
  groups,
  selectedIps,
  onSelectionChange,
  disabled = false,
  label,
  getGroupDisplayName,
}: SpeakerMultiSelectProps) {
  const toggleSpeaker = (ip: string, isDisabled: boolean) => {
    if (isDisabled) return;

    if (selectedIps.includes(ip)) {
      onSelectionChange(selectedIps.filter((selectedIp) => selectedIp !== ip));
    } else {
      onSelectionChange([...selectedIps, ip]);
    }
  };

  const handleKeyDown = (e: KeyboardEvent, ip: string, isDisabled: boolean) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      toggleSpeaker(ip, isDisabled);
    }
  };

  return (
    <div className={styles.container}>
      {label && <span className={styles.label}>{label}</span>}
      <ul className={styles.list} role="listbox" aria-multiselectable="true" aria-label={label}>
        {groups.map((group) => {
          const isSelected = selectedIps.includes(group.coordinatorIp);
          // Disabled if globally disabled OR if it's the last selected item (can't have zero)
          const isDisabled = disabled || (isSelected && selectedIps.length === 1);
          return (
            <li
              key={group.coordinatorIp}
              role="option"
              aria-selected={isSelected}
              aria-disabled={isDisabled}
              tabIndex={isDisabled ? -1 : 0}
              className={[styles.item, isSelected && styles.selected, isDisabled && styles.disabled]
                .filter(Boolean)
                .join(' ')}
              onClick={() => toggleSpeaker(group.coordinatorIp, isDisabled)}
              onKeyDown={(e) => handleKeyDown(e, group.coordinatorIp, isDisabled)}
            >
              <input
                type="checkbox"
                checked={isSelected}
                disabled={isDisabled}
                tabIndex={-1}
                className={styles.checkbox}
                aria-hidden="true"
              />
              <span className={styles.name}>{getGroupDisplayName(group)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
