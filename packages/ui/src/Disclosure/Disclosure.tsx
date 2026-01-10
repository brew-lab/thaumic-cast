import type { ComponentChildren } from 'preact';
import { useState, useCallback } from 'preact/hooks';
import { ChevronDown, ChevronUp } from 'lucide-preact';
import styles from './Disclosure.module.css';

interface DisclosureProps {
  /** Label shown on the toggle button */
  label: string;
  /** Optional hint text below the label */
  hint?: string;
  /** Content to show when expanded */
  children: ComponentChildren;
  /** Whether the disclosure starts expanded (default: false) */
  defaultExpanded?: boolean;
  /** Controlled expanded state */
  expanded?: boolean;
  /** Called when expanded state changes */
  onExpandedChange?: (expanded: boolean) => void;
}

/**
 * A collapsible disclosure/accordion component.
 * Shows a toggle button that reveals or hides content.
 *
 * @param props - Component props
 * @param props.label - Label shown on the toggle button
 * @param props.hint - Optional hint text below the label
 * @param props.children - Content to show when expanded
 * @param props.defaultExpanded - Whether the disclosure starts expanded
 * @param props.expanded - Controlled expanded state
 * @param props.onExpandedChange - Called when expanded state changes
 * @returns The rendered Disclosure component
 *
 * @example
 * ```tsx
 * <Disclosure label="Advanced options" hint="For power users">
 *   <p>Hidden content here</p>
 * </Disclosure>
 * ```
 */
export function Disclosure({
  label,
  hint,
  children,
  defaultExpanded = false,
  expanded: controlledExpanded,
  onExpandedChange,
}: DisclosureProps): preact.JSX.Element {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);

  const isControlled = controlledExpanded !== undefined;
  const expanded = isControlled ? controlledExpanded : internalExpanded;

  const handleToggle = useCallback(() => {
    const newValue = !expanded;
    if (!isControlled) {
      setInternalExpanded(newValue);
    }
    onExpandedChange?.(newValue);
  }, [expanded, isControlled, onExpandedChange]);

  const ChevronIcon = expanded ? ChevronUp : ChevronDown;

  return (
    <div className={styles.disclosure}>
      <button
        type="button"
        className={styles.toggle}
        onClick={handleToggle}
        aria-expanded={expanded}
      >
        <span className={styles.label}>{label}</span>
        <ChevronIcon size={16} className={styles.chevron} />
      </button>

      {expanded && hint && <p className={styles.hint}>{hint}</p>}

      {expanded && <div className={styles.content}>{children}</div>}
    </div>
  );
}
