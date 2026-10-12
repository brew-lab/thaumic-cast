/**
 * The artwork-seeded band (DESIGN.md T-colour, M-media): the seed the app samples from the
 * artwork, made safe for the band. The CSS maps it per theme with relative colour.
 */

/** The seed of an open tile's band. */
export interface MediaBand {
  /** The OKLCH hue, 0 to 360. */
  hue: number;
  /** The OKLCH chroma, before each part's cap. */
  chroma: number;
  /**
   * The red guard: a red seed (hue 20 to 40, chroma above .1) keeps its band, and Stop moves
   * off it, so a red Stop never sits on a red card.
   */
  red: boolean;
}

/** Below this chroma a seed reads as grey, so the band takes purple-grey instead. */
export const GREY_CHROMA = 0.03;

/** The purple-grey a grey seed is swapped for (the neutral ladder's hue). */
export const GREY_SEED = { hue: 308, chroma: 0.04 } as const;

/**
 * Makes a sampled colour into the band's seed: a near-grey seed becomes purple-grey, and a
 * red one sets the red guard. The lightness is not used: each part of the band has its own.
 * @param oklch - The sampled colour as [lightness 0–1, chroma, hue]
 * @returns The seed
 */
export function artBand(oklch: readonly [number, number, number]): MediaBand {
  const [, chroma, hue] = oklch;
  if (!(chroma >= GREY_CHROMA)) return { ...GREY_SEED, red: false };
  const h = ((hue % 360) + 360) % 360;
  return { hue: h, chroma, red: h >= 20 && h <= 40 && chroma > 0.1 };
}
