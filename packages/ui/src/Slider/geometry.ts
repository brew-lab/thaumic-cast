/**
 * Where a value sits along a slider, as a percentage of its range.
 * @param value - The value
 * @param min - The low end
 * @param max - The high end
 * @returns 0 to 100
 */
export function percentOf(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

/**
 * The filled part of a slider, as start and end percentages. A plain slider fills from its
 * low end; one with a centre (trim, centred on 0) fills from the centre towards the value,
 * so the centre itself shows no fill.
 * @param value - The value
 * @param min - The low end
 * @param max - The high end
 * @param centre - The centre, if the slider has one
 * @returns The fill's start and end, 0 to 100
 */
export function fillRange(
  value: number,
  min: number,
  max: number,
  centre?: number,
): { start: number; end: number } {
  const at = percentOf(value, min, max);
  if (centre === undefined) return { start: 0, end: at };
  const mid = percentOf(centre, min, max);
  return { start: Math.min(at, mid), end: Math.max(at, mid) };
}

/**
 * The value after Page Up or Page Down: ten steps, kept in range (DESIGN.md A-slider).
 * @param value - The value now
 * @param step - One step
 * @param direction - 1 for Page Up, -1 for Page Down
 * @param min - The low end
 * @param max - The high end
 * @returns The new value
 */
export function pageStep(
  value: number,
  step: number,
  direction: 1 | -1,
  min: number,
  max: number,
): number {
  return Math.min(max, Math.max(min, value + direction * step * 10));
}
