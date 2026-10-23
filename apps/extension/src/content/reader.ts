/**
 * The media reader's logic, kept apart from its entry (media-reader.ts) so tests can run it
 * against a fake page.
 *
 * Runs in the page's MAIN world to read navigator.mediaSession directly: it intercepts
 * metadata, playbackState and setActionHandler, emits structured events to the bridge, and
 * invokes the page's action handlers on control commands.
 *
 * The page's metadata and playbackState still reach the browser's own media session (its media
 * controls, the OS overlay and the media keys read them there): the reader's accessors call the
 * browser's own getter and setter, and only add an emit.
 *
 * Only one reader may run in a page. Every installed copy of the extension (a store install
 * beside an unpacked build, or two unpacked builds) injects its own reader into the same MAIN
 * world, and every reader hears every bridge's control event: with two readers, one press of
 * Next called the page's handler twice and skipped a track. The first reader marks the window
 * and any later one stands down; the one that runs serves every copy's bridge, since they all
 * talk over the same window events.
 *
 * Non-responsibilities:
 * - Message passing (bridge handles this)
 * - Validation (protocol package handles this)
 * - Caching (background handles this)
 */

import { METADATA_EVENT, REQUEST_EVENT, CONTROL_EVENT } from './constants';

/** Marks a window whose media session a reader already serves; shared by every copy. */
export const READER_INSTALLED = Symbol.for('thaumic-cast.media-reader');

/** The page the reader runs in. */
export interface ReaderPage {
  /** The page's window, which carries the events to and from the bridge. */
  readonly win: Pick<Window, 'addEventListener' | 'dispatchEvent'>;
  /** The page's media session; undefined where the browser has none. */
  readonly session: MediaSession | undefined;
}

/**
 * Starts the media reader, unless one already serves this page.
 * @param page - The page's window and media session
 * @returns Whether this call started it (false when a reader was already there)
 */
export function startMediaReader(page: ReaderPage): boolean {
  const { win, session } = page;
  const marked = win as unknown as Record<symbol, unknown>;
  if (marked[READER_INSTALLED]) return false;
  Object.defineProperty(win, READER_INSTALLED, { value: true });

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
      if (!bestSrc || size > bestSize) {
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
    win.dispatchEvent(
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
   * Finds the browser's own accessor for a media session property, on its prototype chain.
   * @param key - The property
   * @returns The accessor's descriptor, or undefined when there is none
   */
  function nativeAccessor(key: 'metadata' | 'playbackState'): PropertyDescriptor | undefined {
    for (let o = session && Object.getPrototypeOf(session); o; o = Object.getPrototypeOf(o)) {
      const desc = Object.getOwnPropertyDescriptor(o, key);
      if (desc) return desc.get && desc.set ? desc : undefined;
    }
    return undefined;
  }

  /**
   * Watches a media session property: every value the page sets still reaches the browser's
   * own media session (its media controls, the OS overlay and the media keys read it there),
   * and each one schedules an emit to the bridge.
   * @param key - The property
   */
  function intercept(key: 'metadata' | 'playbackState'): void {
    if (!session) return;
    const native = nativeAccessor(key);
    // Without the browser's accessor (never in Chrome) the value is kept here.
    let kept: unknown = session[key];

    Object.defineProperty(session, key, {
      get: () => (native ? native.get!.call(session) : kept),
      set: (value: unknown) => {
        // The browser validates the value; a value it refuses throws to the page, as it would
        // without the reader, and is not emitted.
        if (native) native.set!.call(session, value);
        else kept = value;
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
  intercept('metadata');
  intercept('playbackState');
  interceptActionHandler();

  // Handle explicit requests from bridge (for on-demand refresh)
  win.addEventListener(REQUEST_EVENT, emitMediaState);

  // Handle control commands from bridge
  win.addEventListener(CONTROL_EVENT, handleControlCommand);

  // Emit initial state if metadata already set
  if (session?.metadata) {
    emitMediaState();
  }

  return true;
}
