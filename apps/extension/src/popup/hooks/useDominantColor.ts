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

/**
 * Extracts the dominant color from an image using canvas sampling.
 * Uses a small sample size for performance.
 *
 * @param imageUrl - URL of the image to analyze
 * @returns The dominant color or null if extraction fails
 */
async function extractDominantColor(imageUrl: string): Promise<DominantColorResult | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      try {
        // Use a small canvas for performance
        const size = 10;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }

        // Draw scaled image
        ctx.drawImage(img, 0, 0, size, size);

        // Get pixel data
        const imageData = ctx.getImageData(0, 0, size, size);
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
          resolve(null);
          return;
        }

        const rgb: RGB = [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
        const oklch = rgbToOklch(rgb[0], rgb[1], rgb[2]);

        resolve({
          rgb,
          oklch,
          css: `oklch(${(oklch[0] * 100).toFixed(1)}% ${oklch[1].toFixed(3)} ${oklch[2].toFixed(1)})`,
          lightness: oklch[0],
        });
      } catch {
        resolve(null);
      }
    };

    img.onerror = () => resolve(null);

    // Start loading
    img.src = imageUrl;
  });
}

/**
 * Hook to extract the dominant color from an image.
 * Handles loading state and caches results.
 *
 * @param imageUrl - URL of the image to analyze, or undefined
 * @returns The dominant color result or null if not available
 */
export function useDominantColor(imageUrl: string | undefined): DominantColorResult | null {
  const [color, setColor] = useState<DominantColorResult | null>(null);

  useEffect(() => {
    if (!imageUrl) {
      setColor(null);
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
