// MAIN world script - has access to page's navigator.mediaSession
// Communicates with ISOLATED world script via CustomEvent
// Uses event-driven approach instead of polling for better performance
// Intercepts MediaSession API to detect metadata/state changes in real-time

// Track media elements we're listening to
const trackedElements = new WeakSet<HTMLMediaElement>();

// Debounce rapid updates (e.g., during seek operations)
let updateTimeout: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 100;

// Track position state from setPositionState calls
let positionState: { duration?: number; position?: number; playbackRate?: number } | null = null;

// Track which action handlers the site has registered AND store the handlers
const registeredActions = new Set<string>();
const actionHandlers = new Map<string, MediaSessionActionHandler>();

/**
 * Intercept MediaSession API to detect changes in real-time.
 * Since there are no change events in the MediaSession API, we override
 * the setters to be notified when sites update metadata or playback state.
 */
function interceptMediaSession() {
  console.log(
    '[ThaumicCast] interceptMediaSession called, mediaSession exists:',
    !!navigator.mediaSession
  );

  if (!navigator.mediaSession) return;

  const mediaSession = navigator.mediaSession;

  // Store original values (capture anything already set)
  let currentMetadata: MediaMetadata | null = mediaSession.metadata;
  let currentPlaybackState: MediaSessionPlaybackState = mediaSession.playbackState;

  console.log(
    '[ThaumicCast] Initial metadata:',
    currentMetadata?.title,
    'playbackState:',
    currentPlaybackState
  );

  // Override metadata property
  Object.defineProperty(mediaSession, 'metadata', {
    get() {
      return currentMetadata;
    },
    set(value: MediaMetadata | null) {
      console.log('[ThaumicCast] metadata SET intercepted:', value?.title, value?.artist);
      currentMetadata = value;
      scheduleUpdate();
    },
    configurable: true,
    enumerable: true,
  });

  // Override playbackState property
  Object.defineProperty(mediaSession, 'playbackState', {
    get() {
      return currentPlaybackState;
    },
    set(value: MediaSessionPlaybackState) {
      console.log('[ThaumicCast] playbackState SET intercepted:', value);
      currentPlaybackState = value;
      scheduleUpdate();
    },
    configurable: true,
    enumerable: true,
  });

  // Intercept setPositionState to capture duration/position
  const originalSetPositionState = mediaSession.setPositionState?.bind(mediaSession);
  if (originalSetPositionState) {
    mediaSession.setPositionState = (state?: MediaPositionState) => {
      if (state) {
        positionState = {
          duration: state.duration,
          position: state.position,
          playbackRate: state.playbackRate,
        };
      } else {
        positionState = null;
      }
      scheduleUpdate();
      return originalSetPositionState(state);
    };
  }

  // Intercept setActionHandler to track supported actions AND store handlers
  const originalSetActionHandler = mediaSession.setActionHandler.bind(mediaSession);
  mediaSession.setActionHandler = (
    action: MediaSessionAction,
    handler: MediaSessionActionHandler | null
  ) => {
    console.log(
      '[ThaumicCast] setActionHandler intercepted:',
      action,
      handler ? 'added' : 'removed'
    );
    if (handler) {
      registeredActions.add(action);
      actionHandlers.set(action, handler);
    } else {
      registeredActions.delete(action);
      actionHandlers.delete(action);
    }
    return originalSetActionHandler(action, handler);
  };

  console.log('[ThaumicCast] MediaSession interception complete');
}

/**
 * Trigger a MediaSession action by calling the site's registered handler.
 * This allows us to control players that use Web Audio API instead of <audio>/<video> elements.
 */
function triggerMediaSessionAction(action: string): boolean {
  const handler = actionHandlers.get(action);
  if (handler) {
    console.log('[ThaumicCast] Triggering MediaSession action:', action);
    try {
      // Call the handler with a minimal ActionDetails object
      handler({ action: action as MediaSessionAction });
      return true;
    } catch (err) {
      console.error('[ThaumicCast] Failed to trigger action:', action, err);
      return false;
    }
  }
  console.log('[ThaumicCast] No handler registered for action:', action);
  return false;
}

function getMediaInfo() {
  try {
    // First try Media Session API (best data)
    const metadata = navigator.mediaSession?.metadata;
    const playbackState = navigator.mediaSession?.playbackState || 'none';

    // Check for media elements on the page
    const mediaElements = document.querySelectorAll('audio, video');
    const hasMediaElements = mediaElements.length > 0;

    // Check if any media elements are playing
    // Wrap in try-catch as accessing properties can trigger site-specific getters
    let playingElement: Element | undefined;
    let hasSignificantMedia = false;

    for (const el of mediaElements) {
      try {
        const media = el as HTMLMediaElement;
        if (!media.paused) {
          playingElement = el;
        }
        // Consider media significant if it has duration > 1 second or is currently playing
        if (media.duration > 1 || !media.paused) {
          hasSignificantMedia = true;
        }
      } catch {
        // Some sites wrap media elements with custom getters that can throw
      }
    }

    // Determine if something is playing
    const isPlaying = playbackState === 'playing' || !!playingElement;

    // Check if we have rich metadata from Media Session
    const hasMetadata = !!(metadata?.title || metadata?.artist);

    // If nothing is playing AND no metadata AND no significant media elements, return null state
    // This keeps paused media visible (as long as media elements exist on page)
    if (!isPlaying && !hasMetadata && !hasSignificantMedia) {
      return {
        playbackState: 'none',
        hasMetadata: false,
        hasMediaElements: false,
      };
    }

    // Get artwork from Media Session if available
    let artwork: string | undefined;
    if (metadata?.artwork && metadata.artwork.length > 0) {
      const sorted = [...metadata.artwork].sort((a, b) => {
        const aSize = parseInt(a.sizes?.split('x')[0] || '0', 10);
        const bSize = parseInt(b.sizes?.split('x')[0] || '0', 10);
        return bSize - aSize;
      });
      artwork = sorted[0]?.src;
    }

    return {
      title: metadata?.title,
      artist: metadata?.artist,
      album: metadata?.album,
      artwork,
      playbackState: isPlaying ? 'playing' : 'paused',
      hasMetadata,
      hasMediaElements,
      // Include position state if available (from setPositionState interception)
      duration: positionState?.duration,
      position: positionState?.position,
      // Include supported actions so we know what controls to show
      supportedActions: registeredActions.size > 0 ? Array.from(registeredActions) : undefined,
    };
  } catch {
    // If anything throws during media detection, return safe default
    // This can happen on sites like YouTube Music during player initialization
    return {
      playbackState: 'none',
      hasMetadata: false,
      hasMediaElements: false,
    };
  }
}

function sendMediaInfo() {
  const info = getMediaInfo();
  console.log(
    '[ThaumicCast] sendMediaInfo:',
    info?.title,
    info?.playbackState,
    'hasMetadata:',
    info?.hasMetadata
  );
  window.dispatchEvent(new CustomEvent('__thaumic_media_info__', { detail: info }));
}

// Debounced update to avoid flooding during rapid state changes
function scheduleUpdate() {
  if (updateTimeout) {
    clearTimeout(updateTimeout);
  }
  updateTimeout = setTimeout(sendMediaInfo, DEBOUNCE_MS);
}

// Attach event listeners to a media element
function trackMediaElement(el: HTMLMediaElement) {
  if (trackedElements.has(el)) return;
  trackedElements.add(el);

  // Listen for playback state and track changes
  // When these fire, we read navigator.mediaSession.metadata which sites update on track change
  el.addEventListener('play', scheduleUpdate);
  el.addEventListener('pause', scheduleUpdate);
  el.addEventListener('ended', scheduleUpdate);
  el.addEventListener('loadedmetadata', scheduleUpdate); // New track loaded
  el.addEventListener('durationchange', scheduleUpdate); // Track changed (duration updated)
  el.addEventListener('emptied', scheduleUpdate);
}

// Scan for media elements and attach listeners
function scanForMediaElements() {
  document.querySelectorAll('audio, video').forEach((el) => {
    trackMediaElement(el as HTMLMediaElement);
  });
}

// Watch for new media elements added to the DOM
const mediaObserver = new MutationObserver((mutations) => {
  let foundNewMedia = false;

  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node instanceof HTMLMediaElement) {
        trackMediaElement(node);
        foundNewMedia = true;
      } else if (node instanceof Element) {
        // Check children for media elements
        node.querySelectorAll('audio, video').forEach((el) => {
          trackMediaElement(el as HTMLMediaElement);
          foundNewMedia = true;
        });
      }
    }
  }

  if (foundNewMedia) {
    scheduleUpdate();
  }
});

// Listen for requests from the bridge script
window.addEventListener('__thaumic_request_media__', sendMediaInfo);

// Listen for action trigger requests from the bridge script
window.addEventListener('__thaumic_trigger_action__', ((event: CustomEvent<{ action: string }>) => {
  const { action } = event.detail;
  const success = triggerMediaSessionAction(action);
  // Dispatch result back to bridge
  window.dispatchEvent(
    new CustomEvent('__thaumic_action_result__', { detail: { action, success } })
  );
}) as EventListener);

console.log('[ThaumicCast] media-reader.ts loaded at readyState:', document.readyState);

// CRITICAL: Intercept MediaSession API immediately, before sites set metadata
// This must happen as early as possible to catch all metadata updates
// We run at document_start so this should intercept before any site scripts
interceptMediaSession();

// Check if metadata was already set before our interceptor (edge case)
// This can happen if the site's script ran before ours
if (navigator.mediaSession?.metadata) {
  scheduleUpdate();
}

// Wait for DOM to be ready before setting up observers
// At document_start, document.body may not exist yet
function initMediaElementTracking() {
  // Scan for existing media elements and attach event listeners
  scanForMediaElements();

  // Start observing for new media elements added to the DOM
  if (document.body) {
    mediaObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // Send initial state
  sendMediaInfo();
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  // Still loading - wait for DOMContentLoaded
  document.addEventListener('DOMContentLoaded', initMediaElementTracking);
} else {
  // DOM already loaded (shouldn't happen at document_start, but be safe)
  initMediaElementTracking();
}
