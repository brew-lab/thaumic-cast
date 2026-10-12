/**
 * Joins class names, skipping empty and false values.
 * @param names - Class names, or falsy values to skip
 * @returns The joined class list
 */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

/**
 * Data attributes a component passes through to its root. The catalogue uses `data-force`
 * to draw a hover, focus or press state without a pointer (DESIGN.md §10 row 6).
 */
export interface DataAttributes {
  [key: `data-${string}`]: string | undefined;
}

/**
 * Picks the `data-*` attributes out of a props object.
 * @param props - Any props
 * @returns Only the data attributes
 */
export function dataAttributes(props: object): DataAttributes {
  const out: DataAttributes = {};
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('data-')) out[key as `data-${string}`] = value as string | undefined;
  }
  return out;
}
