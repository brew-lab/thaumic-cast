import type { JSX } from 'preact';
import { useCallback } from 'preact/hooks';

/** Minimal shape required for speaker groups */
interface SpeakerGroupBase {
  /** Unique identifier for the group */
  id: string;
  /** Display name for the group */
  name: string;
  /** Coordinator IP address */
  coordinatorIp: string;
}

interface SpeakerMultiSelectProps<T extends SpeakerGroupBase> {
  /** Available speaker groups */
  groups: T[];
  /** Currently selected speaker IPs (coordinator IPs) */
  selectedIps: string[];
  /** Callback when selection changes */
  onSelectionChange: (ips: string[]) => void;
  /** Whether the control is disabled */
  disabled?: boolean;
  /** Function to get display name for a group (defaults to group.name) */
  getGroupDisplayName?: (group: T) => string;
  /** Label for the field */
  label?: string;
  /** Additional CSS class */
  className?: string;
}

/**
 * Multi-select checkbox list for choosing speaker groups.
 * @param props - Component props
 * @param props.groups - Available speaker groups
 * @param props.selectedIps - Currently selected IPs
 * @param props.onSelectionChange - Selection change callback
 * @param props.disabled - Whether control is disabled
 * @param props.getGroupDisplayName - Function to get display name
 * @param props.label - Field label
 * @param props.className - Additional CSS class
 * @returns The rendered SpeakerMultiSelect component
 */
export function SpeakerMultiSelect<T extends SpeakerGroupBase>({
  groups,
  selectedIps,
  onSelectionChange,
  disabled = false,
  getGroupDisplayName,
  label,
  className,
}: SpeakerMultiSelectProps<T>): JSX.Element {
  const getDisplayName = getGroupDisplayName ?? ((g: T) => g.name);

  /**
   * Toggles a speaker group's selection state.
   * @param ip - The coordinator IP to toggle
   */
  const handleToggle = useCallback(
    (ip: string) => {
      if (disabled) return;

      const isSelected = selectedIps.includes(ip);
      if (isSelected) {
        // Remove from selection (but don't allow empty selection)
        if (selectedIps.length > 1) {
          onSelectionChange(selectedIps.filter((s) => s !== ip));
        }
      } else {
        // Add to selection
        onSelectionChange([...selectedIps, ip]);
      }
    },
    [selectedIps, onSelectionChange, disabled],
  );

  /**
   * Handles keyboard navigation for accessibility.
   * @param e - Keyboard event
   * @param ip - The coordinator IP of the current item
   */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent, ip: string) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        handleToggle(ip);
      }
    },
    [handleToggle],
  );

  return (
    <div className={`speakerMultiSelect ${className || ''}`}>
      {label && <span className="speakerMultiSelectLabel">{label}</span>}
      <ul
        className="speakerMultiSelectList"
        role="listbox"
        aria-multiselectable="true"
        aria-label={label}
      >
        {groups.map((group) => {
          const isSelected = selectedIps.includes(group.coordinatorIp);
          const isDisabledItem = disabled || (isSelected && selectedIps.length === 1);
          const itemClass = [
            'speakerMultiSelectItem',
            isSelected && 'speakerMultiSelectItemSelected',
            isDisabledItem && 'speakerMultiSelectItemDisabled',
          ]
            .filter(Boolean)
            .join(' ');

          return (
            <li
              key={group.id}
              className={itemClass}
              role="option"
              aria-selected={isSelected}
              aria-disabled={isDisabledItem}
              tabIndex={disabled ? -1 : 0}
              onClick={() => handleToggle(group.coordinatorIp)}
              onKeyDown={(e) => handleKeyDown(e, group.coordinatorIp)}
            >
              <input
                type="checkbox"
                checked={isSelected}
                disabled={isDisabledItem}
                className="speakerMultiSelectCheckbox"
                tabIndex={-1}
                aria-hidden="true"
                onChange={() => {}} // Controlled by parent click
              />
              <span className="speakerMultiSelectName">{getDisplayName(group)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
