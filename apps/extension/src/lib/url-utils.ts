/**
 * URL utilities for extracting source information from tab URLs.
 *
 * This module provides functions to derive user-friendly source names
 * from URLs, used for displaying the audio source on Sonos devices.
 */

/** Known domain mappings for friendly display names */
const DOMAIN_NAMES: Record<string, string> = {
  'youtube.com': 'YouTube',
  'music.youtube.com': 'YouTube Music',
  'youtu.be': 'YouTube',
  'open.spotify.com': 'Spotify',
  'music.apple.com': 'Apple Music',
  'soundcloud.com': 'SoundCloud',
  'tidal.com': 'Tidal',
  'deezer.com': 'Deezer',
  'pandora.com': 'Pandora',
  'twitch.tv': 'Twitch',
  'netflix.com': 'Netflix',
  'hulu.com': 'Hulu',
  'disneyplus.com': 'Disney+',
  'primevideo.com': 'Prime Video',
  'amazon.com': 'Amazon',
  'hbomax.com': 'HBO Max',
  'max.com': 'Max',
  'peacocktv.com': 'Peacock',
  'vimeo.com': 'Vimeo',
  'dailymotion.com': 'Dailymotion',
  'bandcamp.com': 'Bandcamp',
  'mixcloud.com': 'Mixcloud',
  'audiomack.com': 'Audiomack',
  'radio.com': 'Radio.com',
  'iheart.com': 'iHeartRadio',
  'tunein.com': 'TuneIn',
};

/**
 * Capitalizes the first letter of each word in a hostname.
 * Removes TLD and converts to title case.
 * @param hostname - The hostname to capitalize (e.g., "example.com")
 * @returns Capitalized name (e.g., "Example")
 */
function capitalizeHostname(hostname: string): string {
  // Remove common TLDs and subdomains
  const parts = hostname.split('.');
  // Get the main domain (second to last part, or first if only two parts)
  const mainPart = parts.length > 2 ? parts[parts.length - 2] : parts[0];

  // Capitalize first letter
  return mainPart.charAt(0).toUpperCase() + mainPart.slice(1);
}

/**
 * Extracts a friendly source name from a URL.
 * Uses known domain mappings for popular services, falls back to
 * capitalized hostname for unknown domains.
 *
 * @param url - The tab URL (may be undefined)
 * @returns Friendly source name (e.g., "YouTube", "Spotify") or "Browser" as fallback
 *
 * @example
 * getSourceFromUrl('https://www.youtube.com/watch?v=123') // "YouTube"
 * getSourceFromUrl('https://open.spotify.com/track/abc') // "Spotify"
 * getSourceFromUrl('https://example.com/audio') // "Example"
 * getSourceFromUrl(undefined) // "Browser"
 */
export function getSourceFromUrl(url: string | undefined): string {
  if (!url) {
    return 'Browser';
  }

  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');

    // Check known domains first
    if (hostname in DOMAIN_NAMES) {
      return DOMAIN_NAMES[hostname];
    }

    // Check for subdomains of known domains (e.g., music.youtube.com)
    for (const [domain, name] of Object.entries(DOMAIN_NAMES)) {
      if (hostname.endsWith(`.${domain}`) || hostname === domain) {
        return name;
      }
    }

    // Fallback to capitalized hostname
    return capitalizeHostname(hostname);
  } catch {
    return 'Browser';
  }
}
