import { Play, Pause, Square, Loader } from 'lucide-preact';
import type { TransportState } from '@thaumic-cast/protocol';
import styles from './TransportIcon.module.css';

interface TransportIconProps {
  /** The transport state to display */
  state: TransportState | undefined;
  /** Icon size in pixels */
  size?: number;
  /** Additional CSS class */
  className?: string;
}

/** Map of transport states to their icon components */
const ICONS = {
  Playing: Play,
  PAUSED_PLAYBACK: Pause,
  Stopped: Square,
  Transitioning: Loader,
} as const;

/**
 * Displays a transport state icon.
 * Uses lucide-preact icons for consistent styling.
 * @param props - Component props
 * @param props.state - Transport state to display
 * @param props.size - Icon size in pixels
 * @param props.className - Additional CSS class
 * @returns The rendered TransportIcon component or null if no state
 */
export function TransportIcon({ state, size = 16, className }: TransportIconProps) {
  if (!state) return null;

  const Icon = ICONS[state];
  const isAnimating = state === 'Transitioning';

  return (
    <span
      className={`${styles.icon} ${isAnimating ? styles.animating : ''} ${className ?? ''}`}
      title={state}
    >
      <Icon size={size} />
    </span>
  );
}
