import { useState, useEffect } from 'preact/hooks';

/**
 * RGB color tuple.
 */
type RGB = [number, number, number];

/**
 * OKLCH color tuple [lightness, chroma, hue].
 */
type OKLCH = [number, number, number];

/**
 * Converts RGB to OKLCH color space.
 * Uses simplified conversion via OKLab intermediate.
 *
 * @param r - Red (0-255)
 * @param g - Green (0-255)
 * @param b - Blue (0-255)
 * @returns OKLCH tuple [lightness (0-1), chroma (0-0.4+), hue (0-360)]
 */
function rgbToOklch(r: number, g: number, b: number): OKLCH {
  // Normalize to 0-1
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;

  // Linear RGB (gamma correction)
  const rl = rn <= 0.04045 ? rn / 12.92 : Math.pow((rn + 0.055) / 1.055, 2.4);
  const gl = gn <= 0.04045 ? gn / 12.92 : Math.pow((gn + 0.055) / 1.055, 2.4);
  const bl = bn <= 0.04045 ? bn / 12.92 : Math.pow((bn + 0.055) / 1.055, 2.4);

  // RGB to OKLab via LMS
  const l = Math.cbrt(0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl);
  const m = Math.cbrt(0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl);
  const s = Math.cbrt(0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl);

  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bLab = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  // OKLab to OKLCH
  const C = Math.sqrt(a * a + bLab * bLab);
  let H = (Math.atan2(bLab, a) * 180) / Math.PI;
  if (H < 0) H += 360;

  return [L, C, H];
}

/**
 * Extracted color result.
 */
export interface DominantColorResult {
  /** The dominant color as an RGB array */
  rgb: RGB;
  /** The dominant color as OKLCH [lightness, chroma, hue] */
  oklch: OKLCH;
  /** The color as a CSS oklch() string */
  css: string;
  /** Lightness value (0-1) for contrast decisions */
  lightness: number;
}

/** In-memory cache for extracted colors */
const colorCache = new Map<string, DominantColorResult | null>();

/** Storage key for persistent cache */
const STORAGE_KEY = 'dominantColorCache';

/** Max entries to persist (LRU-style limit) */
const MAX_CACHE_ENTRIES = 50;

/** Reusable canvas for color extraction */
let sharedCanvas: HTMLCanvasElement | null = null;
let sharedCtx: CanvasRenderingContext2D | null = null;

const CANVAS_SIZE = 10;

/** Whether we've loaded from storage */
let cacheLoaded = false;

/**
 * Loads cached colors from session storage into memory.
 * Called once on first use.
 */
async function loadCacheFromStorage(): Promise<void> {
  if (cacheLoaded) return;
  cacheLoaded = true;

  try {
    const result = await chrome.storage.session.get(STORAGE_KEY);
    const stored = result[STORAGE_KEY];
    if (Array.isArray(stored)) {
      for (const [url, data] of stored) {
        colorCache.set(url, data);
      }
    }
  } catch {
    // Storage not available or error - continue with empty cache
  }
}

/**
 * Persists current cache to session storage.
 */
async function saveCacheToStorage(): Promise<void> {
  try {
    // Limit entries to prevent storage bloat
    const entries = Array.from(colorCache.entries()).slice(-MAX_CACHE_ENTRIES);
    await chrome.storage.session.set({ [STORAGE_KEY]: entries });
  } catch {
    // Storage not available - ignore
  }
}

// Load cache immediately on module init
loadCacheFromStorage();

/**
 * Gets or creates the shared canvas for color extraction.
 */
function getSharedCanvas(): CanvasRenderingContext2D | null {
  if (!sharedCanvas) {
    sharedCanvas = document.createElement('canvas');
    sharedCanvas.width = CANVAS_SIZE;
    sharedCanvas.height = CANVAS_SIZE;
    sharedCtx = sharedCanvas.getContext('2d', { willReadFrequently: true });
  }
  return sharedCtx;
}

/** Timeout for image loading (ms) */
const LOAD_TIMEOUT = 5000;

/**
 * Extracts the dominant color from an image using canvas sampling.
 * Uses createImageBitmap for efficient resizing of large images.
 * Results are cached to avoid re-processing the same image.
 *
 * @param imageUrl - URL of the image to analyze
 * @returns The dominant color or null if extraction fails
 */
async function extractDominantColor(imageUrl: string): Promise<DominantColorResult | null> {
  // Check cache first
  if (colorCache.has(imageUrl)) {
    return colorCache.get(imageUrl) ?? null;
  }

  try {
    // Fetch with timeout to avoid hanging on slow images
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LOAD_TIMEOUT);

    const response = await fetch(imageUrl, {
      signal: controller.signal,
      mode: 'cors',
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      colorCache.set(imageUrl, null);
      return null;
    }

    const blob = await response.blob();

    // Use createImageBitmap with resize - scales during decode (memory efficient)
    const bitmap = await createImageBitmap(blob, {
      resizeWidth: CANVAS_SIZE,
      resizeHeight: CANVAS_SIZE,
      resizeQuality: 'low',
    });

    const ctx = getSharedCanvas();
    if (!ctx) {
      bitmap.close();
      colorCache.set(imageUrl, null);
      return null;
    }

    // Draw the already-resized bitmap
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    // Get pixel data
    const imageData = ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    const pixels = imageData.data;

    // Accumulate color values (simple average approach)
    let r = 0,
      g = 0,
      b = 0,
      count = 0;

    for (let i = 0; i < pixels.length; i += 4) {
      const pr = pixels[i];
      const pg = pixels[i + 1];
      const pb = pixels[i + 2];
      const pa = pixels[i + 3];

      // Skip transparent pixels
      if (pa < 128) continue;

      // Skip very dark or very light pixels (often background)
      const brightness = (pr + pg + pb) / 3;
      if (brightness < 20 || brightness > 235) continue;

      r += pr;
      g += pg;
      b += pb;
      count++;
    }

    if (count === 0) {
      colorCache.set(imageUrl, null);
      return null;
    }

    const rgb: RGB = [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
    const oklch = rgbToOklch(rgb[0], rgb[1], rgb[2]);

    const result: DominantColorResult = {
      rgb,
      oklch,
      css: `oklch(${(oklch[0] * 100).toFixed(1)}% ${oklch[1].toFixed(3)} ${oklch[2].toFixed(1)})`,
      lightness: oklch[0],
    };

    colorCache.set(imageUrl, result);
    saveCacheToStorage();
    return result;
  } catch {
    colorCache.set(imageUrl, null);
    return null;
  }
}

/**
 * Hook to extract the dominant color from an image.
 * Results are cached so subsequent calls with the same URL return instantly.
 *
 * @param imageUrl - URL of the image to analyze, or undefined
 * @returns The dominant color result or null if not available
 */
export function useDominantColor(imageUrl: string | undefined): DominantColorResult | null {
  // Check cache synchronously to avoid flicker
  const cachedResult = imageUrl ? colorCache.get(imageUrl) : undefined;
  const [color, setColor] = useState<DominantColorResult | null>(cachedResult ?? null);

  useEffect(() => {
    if (!imageUrl) {
      setColor(null);
      return;
    }

    // If already cached, use it immediately
    if (colorCache.has(imageUrl)) {
      setColor(colorCache.get(imageUrl) ?? null);
      return;
    }

    let cancelled = false;

    extractDominantColor(imageUrl).then((result) => {
      if (!cancelled) {
        setColor(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  return color;
}
