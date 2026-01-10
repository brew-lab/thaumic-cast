/**
 * Media Reader (MAIN world)
 *
 * Content script that reads MediaSession metadata and action handlers from the page.
 * Runs in MAIN world to access navigator.mediaSession directly.
 *
 * Responsibilities:
 * - Intercept MediaSession.metadata changes
 * - Intercept MediaSession.setActionHandler to track supported actions
 * - Extract and normalize metadata
 * - Select best artwork (largest available)
 * - Emit structured events to bridge
 * - Invoke action handlers on control commands
 *
 * Non-responsibilities:
 * - Message passing (bridge handles this)
 * - Validation (protocol package handles this)
 * - Caching (background handles this)
 */

import { METADATA_EVENT, REQUEST_EVENT, CONTROL_EVENT } from './constants';

(function mediaReaderMain() {
  /**
   * Minimal logger for MAIN world context.
   * Errors always log (same as shared Logger behavior).
   */
  const log = {
    error: (message: string, ...args: unknown[]) => {
      console.error(`[MediaReader] ${message}`, ...args);
    },
  };

  /** Debounce interval in milliseconds */
  const DEBOUNCE_MS = 150;

  /** Actions we track for playback controls */
  const TRACKED_ACTIONS = ['play', 'pause', 'nexttrack', 'previoustrack'] as const;
  type TrackedAction = (typeof TRACKED_ACTIONS)[number];

  interface RawMediaState {
    title?: string;
    artist?: string;
    album?: string;
    artwork?: string;
    supportedActions: TrackedAction[];
    playbackState: MediaSessionPlaybackState;
  }

  /** Registered action handlers from the page */
  const actionHandlers = new Map<string, MediaSessionActionHandler>();

  /** Set of currently supported actions */
  const supportedActions = new Set<TrackedAction>();

  /**
   * Selects the largest artwork URL from the MediaImage array.
   * @param artwork - Array of media images to select from
   * @returns The URL of the largest artwork or undefined
   */
  function selectBestArtwork(artwork: readonly MediaImage[] | undefined): string | undefined {
    if (!artwork?.length) return undefined;

    let bestSrc: string | undefined;
    let bestSize = 0;

    for (const img of artwork) {
      const size = parseInt(img.sizes?.split('x')[0] || '0', 10);
      if (size > bestSize || !bestSrc) {
        bestSize = size;
        bestSrc = img.src;
      }
    }

    return bestSrc;
  }

  /**
   * Extracts normalized media state from MediaSession.
   * @returns Normalized media state including metadata and supported actions
   */
  function extractMediaState(): RawMediaState {
    const session = navigator.mediaSession;
    const metadata = session?.metadata;

    return {
      title: metadata?.title || undefined,
      artist: metadata?.artist || undefined,
      album: metadata?.album || undefined,
      artwork: selectBestArtwork(metadata?.artwork),
      supportedActions: Array.from(supportedActions),
      playbackState: session?.playbackState ?? 'none',
    };
  }

  /**
   * Emits media state to the bridge script via custom event.
   */
  function emitMediaState(): void {
    const state = extractMediaState();
    // Only emit if we have metadata title OR supported actions
    const hasContent = state.title || state.supportedActions.length > 0;
    window.dispatchEvent(
      new CustomEvent(METADATA_EVENT, {
        detail: hasContent ? state : null,
      }),
    );
  }

  // Debounce timer for rapid updates
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Schedules a debounced media state emit.
   */
  function scheduleEmit(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(emitMediaState, DEBOUNCE_MS);
  }

  /**
   * Checks if an action is one we track for playback controls.
   * @param action - The action to check
   * @returns True if this is a tracked action
   */
  function isTrackedAction(action: string): action is TrackedAction {
    return TRACKED_ACTIONS.includes(action as TrackedAction);
  }

  /**
   * Intercepts MediaSession.metadata setter to capture changes.
   */
  function interceptMetadata(): void {
    const session = navigator.mediaSession;
    if (!session) return;

    let currentMetadata = session.metadata;

    Object.defineProperty(session, 'metadata', {
      get: () => currentMetadata,
      set: (value: MediaMetadata | null) => {
        currentMetadata = value;
        scheduleEmit();
      },
      configurable: true,
      enumerable: true,
    });
  }

  /**
   * Intercepts MediaSession.playbackState setter to capture changes.
   */
  function interceptPlaybackState(): void {
    const session = navigator.mediaSession;
    if (!session) return;

    let currentPlaybackState = session.playbackState;

    Object.defineProperty(session, 'playbackState', {
      get: () => currentPlaybackState,
      set: (value: MediaSessionPlaybackState) => {
        currentPlaybackState = value;
        scheduleEmit();
      },
      configurable: true,
      enumerable: true,
    });
  }

  /**
   * Intercepts MediaSession.setActionHandler to track supported actions.
   */
  function interceptActionHandler(): void {
    const session = navigator.mediaSession;
    if (!session) return;

    const originalSetActionHandler = session.setActionHandler.bind(session);

    session.setActionHandler = (
      action: MediaSessionAction,
      handler: MediaSessionActionHandler | null,
    ) => {
      // Track handlers for actions we care about
      if (isTrackedAction(action)) {
        if (handler) {
          actionHandlers.set(action, handler);
          supportedActions.add(action);
        } else {
          actionHandlers.delete(action);
          supportedActions.delete(action);
        }
        scheduleEmit();
      }

      // Always call original to maintain normal behavior
      return originalSetActionHandler(action, handler);
    };
  }

  /**
   * Handles control commands from the bridge.
   * @param event - Custom event with action details
   */
  function handleControlCommand(event: Event): void {
    const { action } = (event as CustomEvent<{ action: string }>).detail;
    const handler = actionHandlers.get(action);

    if (handler) {
      try {
        handler({ action: action as MediaSessionAction });
      } catch (error) {
        log.error('Failed to invoke action handler:', action, error);
      }
    }
  }

  // Initialize interceptions
  interceptMetadata();
  interceptPlaybackState();
  interceptActionHandler();

  // Handle explicit requests from bridge (for on-demand refresh)
  window.addEventListener(REQUEST_EVENT, emitMediaState);

  // Handle control commands from bridge
  window.addEventListener(CONTROL_EVENT, handleControlCommand);

  // Emit initial state if metadata already set
  if (navigator.mediaSession?.metadata) {
    emitMediaState();
  }
})();
