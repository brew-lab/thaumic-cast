import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import type { VideoSyncPhase } from '@thaumic-cast/protocol';
import { useAnnouncer } from '../Announcer';
import { Badge, type BadgeTone } from '../Badge';
import { Button } from '../Button';
import { Disclosure } from '../Disclosure';
import { Divider } from '../Divider';
import { Slider } from '../Slider';
import { Switch } from '../Switch';
import styles from './VideoSync.module.css';

/** The phases that draw a Badge: every phase but off. */
export type VideoSyncShownPhase = Exclude<VideoSyncPhase, 'off'>;

/** The words VideoSync needs, from the app's locale. */
export interface VideoSyncStrings {
  /** `video_sync`: "Video sync", the one name of the row and its Switch. */
  label: string;
  /** `video_sync_status_*`: one word per phase, off excepted ("Locking on…", "In step"). */
  phases: Record<VideoSyncShownPhase, string>;
  /** `video_sync_trim`: "Fine-tune for {{speaker}}", the fold and the trim slider's name. */
  fineTune: string;
  /** The trim as the readout and the fold's summary show it: "+120 ms". */
  ms: (trim: number) => string;
  /** The trim in words, read as `aria-valuetext`: "Sound 120 ms earlier". */
  trimWords: (trim: number) => string;
}

/** The one thing the row offers to do about its phase: "Reload page" or "Try again". */
export interface VideoSyncAction {
  /** The Button's words. */
  label: string;
  /** Does it. Its result is the next phase, so the Button has no busy or failed state. */
  onPress: () => void;
}

/** Each phase's Badge tone: never colour alone (busy carries the Clacks, warning a glyph). */
export const VIDEO_SYNC_TONE: Record<VideoSyncShownPhase, BadgeTone> = {
  locking: 'busy',
  'in-step': 'neutral',
  'no-video': 'neutral',
  unavailable: 'warning',
  'turned-off': 'warning',
};

/** Props for {@link VideoSync}. */
export interface VideoSyncProps {
  /** On for this cast. */
  on: boolean;
  /**
   * Where it stands, from the background. Undefined until it answers, or when it says the
   * cast has no video sync running: then there is no Badge and no Fine-tune.
   */
  phase?: VideoSyncPhase;
  /** Why, in words, when the phase is unavailable or turned off. */
  reason?: string;
  /** What the row offers to do about it, chosen by the app. */
  action?: VideoSyncAction;
  /** The trim in ms, −500 to +500. */
  trim: number;
  /** Turns it on or off. */
  onToggle: (on: boolean) => void;
  /** Sets the trim. */
  onTrim: (trim: number) => void;
  /** Fine-tune is open, when the caller holds it (it never opens by itself). */
  fineTuneOpen?: boolean;
  /** Opens or shuts Fine-tune. */
  onFineTuneChange?: (open: boolean) => void;
  /** The words. */
  strings: VideoSyncStrings;
}

/** The trim's range and step, in ms. */
const TRIM = { min: -500, max: 500, step: 10 } as const;

/**
 * One cast's video sync, in the open CastTile (DESIGN.md M-videosync). A rule, then the
 * Switch row ("Video sync" with the phase's Badge inside the one name, and the reason as its
 * description), then the action, if any, as a flush quiet Button, then, while a trim applies,
 * the "Fine-tune for {{speaker}}" fold with the trim Slider. A change of phase or reason after
 * the first is said once through the Announcer; nothing is said on open or for off. If the
 * action's Button had focus when it goes away, focus moves to the Switch.
 * @param props - Component props
 * @param props.on - On
 * @param props.phase - Where it stands
 * @param props.reason - Why, in words
 * @param props.action - What the row offers to do
 * @param props.trim - The trim in ms
 * @param props.onToggle - Turns it on or off
 * @param props.onTrim - Sets the trim
 * @param props.fineTuneOpen - Fine-tune is open
 * @param props.onFineTuneChange - Opens or shuts Fine-tune
 * @param props.strings - The words
 * @returns The video sync row
 */
export function VideoSync({
  on,
  phase,
  reason,
  action,
  trim,
  onToggle,
  onTrim,
  fineTuneOpen,
  onFineTuneChange,
  strings,
}: VideoSyncProps): JSX.Element {
  const { say } = useAnnouncer();
  const shown = on && phase !== undefined && phase !== 'off' ? phase : undefined;
  const why =
    shown && (shown === 'unavailable' || shown === 'turned-off') && reason ? reason : undefined;
  const offer = on ? action : undefined;
  const fineTune = shown !== undefined && shown !== 'unavailable';

  // Focus never falls to <body> when the action goes (2.4.3): it moves to the Switch.
  const rowRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLDivElement>(null);
  const actionHadFocus = useRef(false);
  if (actionRef.current)
    actionHadFocus.current = actionRef.current.contains(document.activeElement);
  useLayoutEffect(() => {
    if (offer || !actionHadFocus.current) return;
    actionHadFocus.current = false;
    rowRef.current?.querySelector<HTMLElement>('[role="switch"]')?.focus();
  }, [offer]);

  // Said on change only: the first phase after mount is drawn, not said.
  const said = useRef<string | null>(null);
  useEffect(() => {
    const now = shown ? `${shown}|${why ?? ''}` : 'off';
    if (said.current === null) {
      if (phase !== undefined || !on) said.current = now;
      return;
    }
    if (now === said.current) return;
    said.current = now;
    if (!shown) return;
    // A phase word that already ends in "…" takes no full stop after it.
    const word = strings.phases[shown];
    const stop = /[.…]$/.test(word) ? '' : '.';
    say(`${strings.label}. ${word}${stop}${why ? ` ${why}` : ''}`);
  }, [shown, why, phase, on]);

  return (
    <div ref={rowRef} class={styles.sync}>
      <Divider />
      <Switch
        checked={on}
        onChange={onToggle}
        label={strings.label}
        badge={
          shown ? <Badge tone={VIDEO_SYNC_TONE[shown]} label={strings.phases[shown]} /> : undefined
        }
        description={why}
      />
      {offer && (
        <div ref={actionRef} class={styles.action}>
          <Button kind="quiet" flush onClick={offer.onPress}>
            {offer.label}
          </Button>
        </div>
      )}
      {fineTune && (
        <Disclosure
          label={strings.fineTune}
          summary={strings.ms(trim)}
          open={fineTuneOpen}
          onOpenChange={onFineTuneChange}
        >
          <Slider
            label={strings.fineTune}
            min={TRIM.min}
            max={TRIM.max}
            step={TRIM.step}
            centre={0}
            value={trim}
            readout={7}
            format={strings.ms}
            valueText={strings.trimWords}
            onChange={onTrim}
          />
        </Disclosure>
      )}
    </div>
  );
}
