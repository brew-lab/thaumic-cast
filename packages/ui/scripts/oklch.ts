/**
 * sRGB hex ⇄ OKLCH, with no dependency. The token generator uses it to write the drawings'
 * hex values as OKLCH that the browser maps back to the same hex.
 */

/** An OKLCH colour: lightness 0–1, chroma, hue in degrees. */
export interface Oklch {
  /** Lightness, 0 to 1. */
  l: number;
  /** Chroma. */
  c: number;
  /** Hue in degrees, 0 to 360. */
  h: number;
}

const toLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number): number =>
  v <= 0.0031308 ? 12.92 * v : 1.055 * Math.sign(v) * Math.abs(v) ** (1 / 2.4) - 0.055;

/**
 * Converts `#rrggbb` to OKLCH.
 * @param hex - The colour, as six hex digits with a leading `#`
 * @returns The OKLCH colour
 */
export function hexToOklch(hex: string): Oklch {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const [r, g, b] = m.slice(1).map((x) => toLinear(parseInt(x, 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s;
  const c = Math.hypot(A, B);
  const h = c < 1e-4 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c: c < 1e-4 ? 0 : c, h };
}

/**
 * Converts OKLCH to sRGB channels (0–1, unclamped).
 * @param color - The OKLCH colour
 * @param color.l - Lightness, 0 to 1
 * @param color.c - Chroma
 * @param color.h - Hue in degrees
 * @returns The red, green and blue channels
 */
export function oklchToRgb({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    toGamma(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    toGamma(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    toGamma(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}

/**
 * Converts OKLCH to `#rrggbb`, clamping to sRGB.
 * @param color - The OKLCH colour
 * @returns The hex colour
 */
export function oklchToHex(color: Oklch): string {
  return (
    '#' +
    oklchToRgb(color)
      .map((v) =>
        Math.round(Math.min(1, Math.max(0, v)) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

const trim = (n: number, digits: number): string => {
  const s = n.toFixed(digits).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};

/**
 * Writes a hex colour as the shortest `oklch()` that maps back to the same hex and stays
 * inside sRGB, so the browser shows exactly the drawn colour.
 * @param hex - The colour, as `#rrggbb`
 * @returns The CSS `oklch(L% C H)` string
 */
export function hexToOklchCss(hex: string): string {
  const exact = hexToOklch(hex);
  const target = hex.toLowerCase();
  for (let lp = 1; lp <= 2; lp++) {
    for (let cp = 3; cp <= 4; cp++) {
      for (let hp = 1; hp <= 2; hp++) {
        const l = Number((exact.l * 100).toFixed(lp)) / 100;
        const c = Number(exact.c.toFixed(cp));
        const h = c === 0 ? 0 : Number(exact.h.toFixed(hp));
        const rgb = oklchToRgb({ l, c, h });
        const inGamut = rgb.every((v) => v > -0.5 / 255 && v < 1 + 0.5 / 255);
        if (inGamut && oklchToHex({ l, c, h }) === target) {
          return `oklch(${trim(l * 100, lp)}% ${trim(c, cp)} ${trim(h, hp)})`;
        }
      }
    }
  }
  throw new Error(`No short oklch() maps back to ${hex}`);
}
