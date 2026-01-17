import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Media Metadata Types (for tab-level metadata display)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Supported media control actions from the MediaSession API.
 * These map directly to MediaSessionAction values.
 */
export const MediaActionSchema = z.enum(['play', 'pause', 'nexttrack', 'previoustrack']);
export type MediaAction = z.infer<typeof MediaActionSchema>;

/**
 * Playback state from MediaSession API.
 * Maps directly to MediaSessionPlaybackState values.
 */
export const PlaybackStateSchema = z.enum(['none', 'paused', 'playing']);
export type PlaybackState = z.infer<typeof PlaybackStateSchema>;

/**
 * Media metadata captured from the Web MediaSession API.
 * This is the canonical shape used for displaying track info.
 * Title is required; other fields are optional.
 */
export const MediaMetadataSchema = z.object({
  /** Track title (required) */
  title: z.string().min(1),
  /** Artist name */
  artist: z.string().optional(),
  /** Album name */
  album: z.string().optional(),
  /** Artwork URL (largest available) */
  artwork: z.string().url().optional(),
});
export type MediaMetadata = z.infer<typeof MediaMetadataSchema>;

/**
 * Validates and parses raw metadata into MediaMetadata.
 * Returns null if title is missing or invalid.
 * @param data - Raw metadata object to parse
 * @returns Validated MediaMetadata or null if invalid
 */
export function parseMediaMetadata(data: unknown): MediaMetadata | null {
  const result = MediaMetadataSchema.safeParse(data);
  return result.success ? result.data : null;
}

/**
 * Complete media state for a browser tab.
 * Combines metadata with tab identification for display.
 */
export const TabMediaStateSchema = z.object({
  /** Chrome tab ID */
  tabId: z.number().int().positive(),
  /** Tab title (fallback when no metadata) */
  tabTitle: z.string(),
  /** Tab favicon URL */
  tabFavicon: z.string().optional(),
  /** Tab Open Graph image URL (og:image meta tag) */
  tabOgImage: z.string().optional(),
  /** Source name derived from tab URL (e.g., "YouTube", "Spotify") */
  source: z.string().optional(),
  /** Media metadata if available */
  metadata: MediaMetadataSchema.nullable(),
  /** Supported media actions (play, pause, next, previous) */
  supportedActions: z.array(MediaActionSchema).default([]),
  /** Current playback state from MediaSession */
  playbackState: PlaybackStateSchema.default('none'),
  /** Timestamp when this state was last updated */
  updatedAt: z.number(),
});
export type TabMediaState = z.infer<typeof TabMediaStateSchema>;

/**
 * Creates a TabMediaState with defaults.
 * @param tab - Tab information from Chrome API
 * @param tab.id
 * @param tab.title
 * @param tab.favIconUrl
 * @param tab.ogImage - Open Graph image URL
 * @param tab.source - Source name derived from tab URL
 * @param metadata - Optional media metadata
 * @param supportedActions - Optional array of supported media actions
 * @param playbackState - Optional playback state from MediaSession
 * @returns A new TabMediaState object
 */
export function createTabMediaState(
  tab: { id: number; title?: string; favIconUrl?: string; ogImage?: string; source?: string },
  metadata: MediaMetadata | null = null,
  supportedActions: MediaAction[] = [],
  playbackState: PlaybackState = 'none',
): TabMediaState {
  return {
    tabId: tab.id,
    tabTitle: tab.title || 'Unknown Tab',
    tabFavicon: tab.favIconUrl,
    tabOgImage: tab.ogImage,
    source: tab.source,
    metadata,
    supportedActions,
    playbackState,
    updatedAt: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Display Helpers (DRY - single source of truth for display logic)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gets the display title from media state.
 * Prefers metadata title, falls back to tab title.
 * @param state - The tab media state
 * @returns The title to display
 */
export function getDisplayTitle(state: TabMediaState): string {
  return state.metadata?.title || state.tabTitle;
}

/**
 * Gets the display image from media state.
 * Prefers artwork, falls back to og:image, then favicon.
 * @param state - The tab media state
 * @returns The image URL to display, or undefined if none available
 */
export function getDisplayImage(state: TabMediaState): string | undefined {
  return state.metadata?.artwork || state.tabOgImage || state.tabFavicon;
}

/**
 * Gets the display subtitle from media state.
 * Returns artist/album string or undefined if no artist.
 * @param state - The tab media state
 * @returns The subtitle to display, or undefined if no artist
 */
export function getDisplaySubtitle(state: TabMediaState): string | undefined {
  const { metadata } = state;
  if (!metadata?.artist) return undefined;
  return metadata.album ? `${metadata.artist} • ${metadata.album}` : metadata.artist;
}
