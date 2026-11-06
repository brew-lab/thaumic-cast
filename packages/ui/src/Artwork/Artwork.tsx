import type { JSX } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
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
 * icon disc. The placeholder holds the space while the image loads, so nothing shifts, and
 * fades out as the image fades in (a transparent image must not show it through); if the
 * image fails, the placeholder stays. Always decorative: the title beside it names it.
 * @param props - Component props
 * @param props.kind - The kind
 * @param props.size - sm, md or lg
 * @param props.src - The picture
 * @param props.glyph - The disc or placeholder glyph
 * @returns The artwork
 */
export function Artwork({ kind, size, src, glyph }: ArtworkProps): JSX.Element {
  // How the current picture settled. It names its src, and is dropped during the render that
  // changes src, so a load that lands before the effects run is never undone, and a picture
  // that failed is tried again when it comes back.
  const [settled, setSettled] = useState<{ src?: string; ok: boolean } | null>(null);
  if (settled && settled.src !== src) setSettled(null);
  const outcome = settled?.src === src ? settled?.ok : undefined;
  const loaded = outcome === true;
  const failed = outcome === false;

  // A picture that loaded before this could listen (rendered on the server, then hydrated) fires
  // no load event for us, so read it. Only on mount: a later src always has the listener, and
  // the spec lets the element answer for the old picture until the new one starts.
  const img = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    if (img.current?.complete && img.current.naturalWidth > 0) setSettled({ src, ok: true });
  }, []);

  const picture = (kind === 'image' || kind === 'favicon') && src && !failed;
  const showGlyph = kind !== 'favicon' && size !== 'sm';
  return (
    <span class={cx(styles.artwork, styles[size], styles[kind])} aria-hidden="true">
      {showGlyph && (
        <span class={styles.glyph} data-covered={picture && loaded ? '' : undefined}>
          <Icon glyph={glyph ?? (kind === 'disc' ? 'speaker' : 'music')} />
        </span>
      )}
      {picture && (
        <img
          ref={img}
          class={styles.picture}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          data-loaded={loaded ? '' : undefined}
          onLoad={() => setSettled({ src, ok: true })}
          onError={() => setSettled({ src, ok: false })}
        />
      )}
    </span>
  );
}
