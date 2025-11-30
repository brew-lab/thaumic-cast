// MAIN world script - has access to page's navigator.mediaSession
// Communicates with ISOLATED world script via CustomEvent

function getMediaInfo() {
  // First try Media Session API (best data)
  const metadata = navigator.mediaSession?.metadata;
  const playbackState = navigator.mediaSession?.playbackState || 'none';

  // Check for media elements on the page
  const mediaElements = document.querySelectorAll('audio, video');
  const hasMediaElements = mediaElements.length > 0;

  // Check if any media elements are playing
  const playingElement = Array.from(mediaElements).find((el) => !(el as HTMLMediaElement).paused);

  // Check if any media elements have significant content (not just empty/short)
  const hasSignificantMedia = Array.from(mediaElements).some((el) => {
    const media = el as HTMLMediaElement;
    // Consider media significant if it has duration > 1 second or is currently playing
    return media.duration > 1 || !media.paused;
  });

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
}

function sendMediaInfo() {
  const info = getMediaInfo();
  window.dispatchEvent(new CustomEvent('__thaumic_media_info__', { detail: info }));
}

// Listen for requests from the bridge script
window.addEventListener('__thaumic_request_media__', sendMediaInfo);

// Poll for changes (mediaSession has no change events)
setInterval(sendMediaInfo, 1000);

// Send initial state
sendMediaInfo();
