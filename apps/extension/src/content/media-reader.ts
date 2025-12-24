/**
 * Media Reader (MAIN world)
 *
 * Content script that reads MediaSession metadata from the page.
 * Runs in MAIN world to access navigator.mediaSession directly.
 *
 * Responsibilities:
 * - Intercept MediaSession.metadata changes
 * - Extract and normalize metadata
 * - Select best artwork (largest available)
 * - Emit structured events to bridge
 *
 * Non-responsibilities:
 * - Message passing (bridge handles this)
 * - Validation (protocol package handles this)
 * - Caching (background handles this)
 */

(function mediaReaderMain() {
  /** Event name for metadata updates (reader -> bridge) */
  const METADATA_EVENT = '__thaumic_metadata__';

  /** Event name for metadata requests (bridge -> reader) */
  const REQUEST_EVENT = '__thaumic_request_metadata__';

  /** Debounce interval in milliseconds */
  const DEBOUNCE_MS = 150;

  interface RawMetadata {
    title?: string;
    artist?: string;
    album?: string;
    artwork?: string;
  }

  /**
   * Selects the largest artwork URL from the MediaImage array.
   * @param artwork - Array of media images to select from
   * @returns The URL of the largest artwork or undefined
   */
  function selectBestArtwork(artwork: readonly MediaImage[] | undefined): string | undefined {
    if (!artwork?.length) return undefined;

    const sorted = Array.from(artwork).sort((a, b) => {
      const aSize = parseInt(a.sizes?.split('x')[0] || '0', 10);
      const bSize = parseInt(b.sizes?.split('x')[0] || '0', 10);
      return bSize - aSize;
    });

    return sorted[0]?.src;
  }

  /**
   * Extracts normalized metadata from MediaSession.
   * @returns Normalized metadata or null if unavailable
   */
  function extractMetadata(): RawMetadata | null {
    const session = navigator.mediaSession;
    if (!session?.metadata?.title) return null;

    const { title, artist, album, artwork } = session.metadata;

    return {
      title,
      artist: artist || undefined,
      album: album || undefined,
      artwork: selectBestArtwork(artwork),
    };
  }

  /**
   * Emits metadata to the bridge script via custom event.
   */
  function emitMetadata(): void {
    const metadata = extractMetadata();
    window.dispatchEvent(new CustomEvent(METADATA_EVENT, { detail: metadata }));
  }

  // Debounce timer for rapid updates
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Schedules a debounced metadata emit.
   */
  function scheduleEmit(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(emitMetadata, DEBOUNCE_MS);
  }

  /**
   * Intercepts MediaSession.metadata setter to capture changes.
   */
  function interceptMediaSession(): void {
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

  // Initialize MediaSession interception
  interceptMediaSession();

  // Handle explicit requests from bridge (for on-demand refresh)
  window.addEventListener(REQUEST_EVENT, emitMetadata);

  // Emit initial state if metadata already set
  if (navigator.mediaSession?.metadata) {
    emitMetadata();
  }
})();
