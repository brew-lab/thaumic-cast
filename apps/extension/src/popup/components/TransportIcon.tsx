import type { JSX } from 'preact';
import type { TransportState } from '@thaumic-cast/protocol';
import { Clacks, Icon, type GlyphName } from '@thaumic-cast/ui';
import styles from './TransportIcon.module.css';

interface TransportIconProps {
  /** The transport state to display */
  state: TransportState | undefined;
}

/** The glyph for each settled transport state; a changing one shows the Clacks. */
const GLYPHS: Record<Exclude<TransportState, 'Transitioning'>, GlyphName> = {
  Playing: 'play',
  PAUSED_PLAYBACK: 'pause',
  Stopped: 'stop',
};

/**
 * A speaker's transport state as a small glyph, or the Clacks while it changes.
 * Phase 3 replaces it with Badge words in RoomRow (DESIGN.md §9).
 * @param props - Component props
 * @param props.state - Transport state to display
 * @returns The glyph, or null when there is no state
 */
export function TransportIcon({ state }: TransportIconProps): JSX.Element | null {
  if (!state) return null;
  return (
    <span className={styles.icon} aria-hidden="true">
      {state === 'Transitioning' ? <Clacks size="sm" /> : <Icon glyph={GLYPHS[state]} />}
    </span>
  );
}
