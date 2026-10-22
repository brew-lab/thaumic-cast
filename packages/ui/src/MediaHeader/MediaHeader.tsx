import type { ComponentChildren, JSX } from 'preact';
import { Artwork } from '../Artwork';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { IconButton } from '../IconButton';
import { StatusDot } from '../StatusDot';
import { cx, dataAttributes, type DataAttributes } from '../utils/cx';
import { usePress } from '../utils/press';
import type { MediaBand } from './band';
import styles from './MediaHeader.module.css';

/** The media session's controls, when the tab has one. */
export interface MediaTransport {
  /** Previous track is offered. */
  canPrev: boolean;
  /** Next track is offered. */
  canNext: boolean;
  /** Play and pause are offered. */
  canPlayPause: boolean;
  /** Previous track. */
  onPrev: () => void;
  /** Play or pause, by `playing`. */
  onPlayPause: () => void;
  /** Next track. */
  onNext: () => void;
}

/** The words a MediaHeader needs, from the app's locale. */
export interface MediaHeaderStrings {
  /** `previous_track`. */
  previous: string;
  /** `next_track`. */
  next: string;
  /** `play`. */
  play: string;
  /** `pause`. */
  pause: string;
  /** `go_to_tab`: "Go to tab", named "Go to tab: {{title}}". */
  goToTab: string;
}

/** Props for {@link MediaHeader}. */
export interface MediaHeaderProps extends DataAttributes {
  /** tab: a tab's media; browser: "Whole browser" with a monitor disc, and no transport. */
  kind: 'tab' | 'browser';
  /** The artwork's URL; none draws the placeholder. */
  art?: string;
  /** The media title, or "Whole browser". One line, with an ellipsis. */
  title: string;
  /** The site (TabCard), "Browser-wide capture", or the rooms joined by " + " (a tile). */
  subtitle: string;
  /** Sound is going out: the live dot shows before the subtitle. */
  playing: boolean;
  /** md (a tile, Artwork md) or lg (the TabCard, Artwork lg). */
  size: 'md' | 'lg';
  /**
   * The title as a heading at this level, focusable from script (P-stop moves focus to the
   * TabCard's heading). Not with a disclosure, whose button holds the title.
   */
  level?: 2 | 3;
  /** The title's id, so a section can be named by it. */
  titleId?: string;
  /**
   * A tile's disclosure: one `<button aria-expanded>` round the chevron, the artwork and the
   * text, the same element in the compact and the open form.
   */
  disclosure?: {
    /** Open. */
    expanded: boolean;
    /** The id of what it opens. */
    controls: string;
    /** Opens or shuts it. */
    onToggle: () => void;
  };
  /** The open tile's transport (previous, play or pause, next), when there is a session. */
  transport?: MediaTransport | null;
  /** Go to tab, on the open tile. */
  onGoToTab?: () => void;
  /** A slot at the head's end: the tile puts Stop here. */
  trailing?: ComponentChildren;
  /**
   * The open tile's artwork-seeded band (see `artBand`). `trailing` stays in the head row on
   * every band; with the red guard set, its danger fill takes the band's tonal step.
   */
  band?: MediaBand;
  /**
   * The band reaches its card's top and sides (the open CastTile): it takes the card's inner
   * corner and adds the tile's inset to its padding, so nothing on it moves.
   */
  bleed?: boolean;
  /** The words. */
  strings: MediaHeaderStrings;
}

/**
 * What a tab, or the whole browser, is playing (DESIGN.md M-media): one head for the TabCard
 * and both forms of a CastTile. The artwork, the title (one line, an ellipsis; the name keeps
 * it whole), and the live dot before the subtitle while sound goes out. On a tile the head is
 * a disclosure button; on the open tile it sits on the artwork-seeded band, with the
 * transport and "Go to tab". Stop stays at one spot in every form; on a red band (the red
 * guard) its fill takes the band's tonal step, so a red Stop never sits on a red card.
 * Read-only on the desktop: no disclosure, transport or Stop.
 * @param props - Component props
 * @param props.kind - tab or browser
 * @param props.art - The artwork
 * @param props.title - The title
 * @param props.subtitle - The subtitle
 * @param props.playing - Sound is going out
 * @param props.size - md or lg
 * @param props.level - The title as a heading
 * @param props.titleId - The title's id
 * @param props.disclosure - A tile's disclosure
 * @param props.transport - The transport
 * @param props.onGoToTab - Go to tab
 * @param props.trailing - The head's end slot
 * @param props.band - The artwork-seeded band
 * @param props.bleed - The band reaches its card's edges
 * @param props.strings - The words
 * @returns The header
 */
export function MediaHeader({
  kind,
  art,
  title,
  subtitle,
  playing,
  size,
  level,
  titleId,
  disclosure,
  transport,
  onGoToTab,
  trailing,
  band,
  bleed = false,
  strings,
  ...rest
}: MediaHeaderProps): JSX.Element {
  const press = usePress();
  const browser = kind === 'browser';
  const Title = level && !disclosure ? (`h${level}` as 'h2') : 'span';

  const artwork = browser ? (
    <Artwork kind="disc" size={size} glyph="monitor" />
  ) : (
    <Artwork kind={art ? 'image' : 'placeholder'} size={size} src={art} />
  );
  const text = (
    <span class={styles.text}>
      <Title id={titleId} class={styles.title} tabIndex={Title === 'span' ? undefined : -1}>
        {title}
      </Title>
      <span class={styles.subtitle}>
        {playing && <StatusDot state="live" onFill={Boolean(band)} />}
        <span class={styles.subtitleText}>{subtitle}</span>
      </span>
    </span>
  );

  const controls = !browser && transport && (
    <span class={styles.transport}>
      {transport.canPrev && (
        <IconButton glyph="prev" label={strings.previous} onPress={transport.onPrev} />
      )}
      {transport.canPlayPause && (
        <span class={styles.play}>
          <IconButton
            kind="tonal"
            glyph={playing ? 'pause' : 'play'}
            label={playing ? strings.pause : strings.play}
            onPress={transport.onPlayPause}
          />
        </span>
      )}
      {transport.canNext && (
        <IconButton glyph="next" label={strings.next} onPress={transport.onNext} />
      )}
    </span>
  );

  return (
    <div class={styles.root}>
      <div
        class={cx(
          styles.media,
          styles[size],
          band && styles.band,
          band && bleed && styles.bleed,
          band?.red && styles.redGuard,
        )}
        style={band ? { '--art-h': band.hue, '--art-c': band.chroma } : undefined}
      >
        <div class={styles.head}>
          {disclosure ? (
            <button
              type="button"
              class={styles.toggle}
              aria-expanded={disclosure.expanded}
              aria-controls={disclosure.controls}
              onClick={disclosure.onToggle}
              {...press}
              {...dataAttributes(rest)}
            >
              <span class={styles.chevron}>
                <Icon glyph="chevron-down" />
              </span>
              {artwork}
              {text}
            </button>
          ) : (
            <span class={styles.id}>
              {artwork}
              {text}
            </span>
          )}
          {trailing && <span class={styles.trailing}>{trailing}</span>}
        </div>
        {(controls || (!browser && onGoToTab)) && (
          <div class={styles.actions}>
            {controls}
            {!browser && onGoToTab && (
              <span class={styles.go}>
                <Button
                  kind="quiet"
                  aria-label={`${strings.goToTab}: ${title}`}
                  onClick={onGoToTab}
                >
                  {strings.goToTab}
                </Button>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
