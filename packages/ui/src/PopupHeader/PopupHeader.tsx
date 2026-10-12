import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { useAnnouncer } from '../Announcer';
import { BrandBlock } from '../BrandBlock';
import { IconButton } from '../IconButton';
import { StatusDot, type StatusDotState } from '../StatusDot';
import styles from './PopupHeader.module.css';

/** Who the popup is talking to. */
export type PopupConnection = 'checking' | 'connected' | 'reconnecting' | 'disconnected';

/** Each connection's StatusDot: its own shape, never colour alone. */
export const CONNECTION_DOT: Record<PopupConnection, StatusDotState> = {
  checking: 'checking',
  connected: 'connected',
  reconnecting: 'checking',
  disconnected: 'failed',
};

/** Props for {@link PopupHeader}. */
export interface PopupHeaderProps {
  /** The product name, "Thaumic Cast" (the popup's h1). */
  name: string;
  /** The connection. */
  connection: PopupConnection;
  /**
   * The status words: "Connected to the desktop app", "Looking for a companion…", "Asking
   * the companion again…", "Not connected". Never a count.
   */
  statusText: string;
  /** More about the status, read after it ("The companion has stopped answering…"). */
  description?: string;
  /** A cast is running: the mark is lit. */
  live: boolean;
  /** Opens the settings page. */
  onSettings: () => void;
  /** The Settings button's name. */
  settingsLabel: string;
  /**
   * Set while an update exists: Settings is marked (IconButton `mark`), shows its name in a
   * Tooltip, and is named this instead ("Settings, update available").
   */
  updateLabel?: string;
}

/**
 * Who is talking to the speakers, at the top of the popup (DESIGN.md C-popupheader): the
 * BrandBlock (lit while casting), the StatusDot and its words, and Settings (IconButton
 * tonal md), marked while an update exists. It scrolls away with the page and never shows a
 * count. A change of status is said once, politely, by the Announcer; nothing is said on
 * open, and the line is not a live region.
 * @param props - Component props
 * @param props.name - The product name
 * @param props.connection - The connection
 * @param props.statusText - The status words
 * @param props.description - More about the status
 * @param props.live - A cast is running
 * @param props.onSettings - Opens the settings
 * @param props.settingsLabel - The Settings button's name
 * @param props.updateLabel - Settings' name while an update exists
 * @returns The header
 */
export function PopupHeader({
  name,
  connection,
  statusText,
  description,
  live,
  onSettings,
  settingsLabel,
  updateLabel,
}: PopupHeaderProps): JSX.Element {
  const { say } = useAnnouncer();
  const said = useRef(statusText);
  useEffect(() => {
    if (said.current === statusText) return;
    said.current = statusText;
    say(description ? `${statusText}. ${description}` : statusText);
  }, [statusText, description, say]);

  return (
    <header class={styles.header}>
      <div class={styles.identity}>
        <BrandBlock name={name} lit={live} heading />
        <p class={styles.status} data-connection={connection}>
          <StatusDot state={CONNECTION_DOT[connection]} />
          <span>{statusText}</span>
          {description && <span class="visually-hidden">. {description}</span>}
        </p>
      </div>
      <IconButton
        kind="tonal"
        glyph="settings"
        label={updateLabel ?? settingsLabel}
        mark={updateLabel !== undefined}
        tooltip={updateLabel !== undefined}
        onPress={onSettings}
      />
    </header>
  );
}
