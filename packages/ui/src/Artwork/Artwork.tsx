import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Icon } from '../Icon';
import type { GlyphName } from '../Icon/glyphs';
import { cx } from '../utils/cx';
import styles from './Artwork.module.css';

/** Props for {@link Artwork}. */
export interface ArtworkProps {
  /**
   * image: cover art; favicon: a site icon; placeholder: `music` on the container (also
   * shown while an image loads or when it fails); disc: a round glyph disc.
   */
  kind: 'image' | 'favicon' | 'placeholder' | 'disc';
  /** sm `--icon-sm` (favicons), md `--size-art-md`, lg `--size-art-lg`. */
  size: 'sm' | 'md' | 'lg';
  /** The picture, for image and favicon. */
  src?: string;
  /** The disc's glyph (speaker, monitor, server, puzzle, shield, check), or the placeholder's. */
  glyph?: GlyphName;
}

/**
 * The picture beside a title (DESIGN.md A-art): cover art, a favicon, a placeholder or an
 * icon disc. The placeholder stays under the image, which fades in, so nothing shifts; if
 * the image fails, the placeholder stays. Always decorative: the title beside it names it.
 * @param props - Component props
 * @param props.kind - The kind
 * @param props.size - sm, md or lg
 * @param props.src - The picture
 * @param props.glyph - The disc or placeholder glyph
 * @returns The artwork
 */
export function Artwork({ kind, size, src, glyph }: ArtworkProps): JSX.Element {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [src]);

  const picture = (kind === 'image' || kind === 'favicon') && src && !failed;
  const showGlyph = kind !== 'favicon' && size !== 'sm';
  return (
    <span class={cx(styles.artwork, styles[size], styles[kind])} aria-hidden="true">
      {showGlyph && (
        <span class={styles.glyph}>
          <Icon glyph={glyph ?? (kind === 'disc' ? 'speaker' : 'music')} />
        </span>
      )}
      {picture && (
        <img
          class={styles.picture}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          data-loaded={loaded ? '' : undefined}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
