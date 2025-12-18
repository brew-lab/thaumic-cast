// MAIN world script - has access to page's navigator.mediaSession
// Communicates with ISOLATED world script via CustomEvent
// Uses event-driven approach instead of polling for better performance

// Track media elements we're listening to
const trackedElements = new WeakSet<HTMLMediaElement>();

// Debounce rapid updates (e.g., during seek operations)
let updateTimeout: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 100;

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

// Initialize after a short delay to let sites set up their players
setTimeout(() => {
  // Scan for existing media elements and attach event listeners
  scanForMediaElements();

  // Start observing for new media elements added to the DOM
  mediaObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Send initial state
  sendMediaInfo();
}, 500);
