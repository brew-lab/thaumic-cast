import type { JSX } from 'preact';
import { GLYPHS, type Glyph, type GlyphName } from './glyphs';
import styles from './Icon.module.css';

/** Props for {@link Icon}. */
export interface IconProps {
  /** The glyph to draw, from the inventory (DESIGN.md F-icons). */
  glyph: GlyphName;
  /** The size: sm `--icon-sm`, md `--icon-md`, lg `--icon-lg`. Defaults to sm. */
  size?: 'sm' | 'md' | 'lg';
  /**
   * Makes the glyph meaningful: it is exposed as an image with this name. Without a label
   * the glyph is decorative and hidden, because the control around it carries the name.
   */
  label?: string;
}

/**
 * Draws one glyph from the inventory, in currentColor (DESIGN.md A-icon). It takes its
 * parent's ink, and so its state. Decorative by default.
 * @param props - Component props
 * @param props.glyph - The glyph to draw
 * @param props.size - The size token
 * @param props.label - An accessible name, for a standalone meaningful glyph
 * @returns The SVG element
 */
export function Icon({ glyph, size = 'sm', label }: IconProps): JSX.Element {
  const def: Glyph = GLYPHS[glyph];
  const a11y = label
    ? { role: 'img' as const, 'aria-label': label }
    : { 'aria-hidden': 'true' as const, focusable: 'false' };
  const className = [
    styles.icon,
    styles[size],
    def.filled ? styles.filled : '',
    def.mirror ? styles.mirror : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <svg viewBox="0 0 24 24" class={className} {...a11y}>
      {def.nodes.map(([Tag, attrs], i) => (
        <Tag key={i} {...attrs} />
      ))}
    </svg>
  );
}
