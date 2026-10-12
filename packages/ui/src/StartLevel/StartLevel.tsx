import type { JSX } from 'preact';
import { useId } from 'preact/hooks';
import { Button } from '../Button';
import { Slider } from '../Slider';
import { cx, dataAttributes, type DataAttributes } from '../utils/cx';
import {
  startSettable,
  startShown,
  startWords,
  type StartLevelLevel,
  type StartLevelStrings,
} from './start';
import styles from './StartLevel.module.css';

/** Props for {@link StartLevel}. */
export interface StartLevelProps extends StartLevelLevel, DataAttributes {
  /** The room's name: it names the button and the slider. */
  roomName: string;
  /** "Start no louder than", on at 30 by default; null when it is off. */
  limit: number | null;
  /** The StartLine is open. */
  open: boolean;
  /** Called with the new state when the LevelButton is pressed. */
  onOpenChange: (open: boolean) => void;
  /** Called as the level is set by hand; it is pending until Cast. */
  onSet: (level: number) => void;
  /** The words, from the app's locale. */
  strings: StartLevelStrings;
}

/**
 * The level a chosen room starts at (DESIGN.md M-startlevel, P-start). It is pending: nothing
 * is sent to the speaker before Cast. The LevelButton shows the start and opens the StartLine
 * in place: a Slider with a ghost tick where the room is now, its value, and a caption that
 * describes it. While the level is unknown the LevelButton shows "…" and its StartLine starts
 * at the limit, so the level can still be set by hand (with the limit off, "…" is text); a
 * fixed output shows "Fixed" as text with no button. A level set by hand wins for this cast only, with no warning.
 *
 * It renders two parts side by side in its parent's flow, the LevelButton (`grid-area:
 * level`) and the StartLine (`grid-area: line`), so a RoomRow places them at the row's end and
 * under the row; on its own they simply stack.
 * @param props - Component props
 * @param props.roomName - The room's name
 * @param props.now - The room's level now, if known
 * @param props.set - A level set by hand
 * @param props.fixed - A fixed output
 * @param props.limit - The start limit, or null
 * @param props.open - The StartLine is open
 * @param props.onOpenChange - Opens or shuts the StartLine
 * @param props.onSet - Sets the level by hand
 * @param props.strings - The words
 * @returns The LevelButton and the StartLine
 */
export function StartLevel({
  roomName,
  now,
  set,
  fixed,
  limit,
  open,
  onOpenChange,
  onSet,
  strings,
  ...rest
}: StartLevelProps): JSX.Element {
  const id = useId();
  const shown = startShown({ now, set, fixed }, limit);
  const words = startWords(shown, roomName, strings);

  if (shown.kind === 'fixed' || !startSettable(shown)) {
    return (
      <span class={cx(styles.level, styles.text)}>
        <span aria-hidden="true">{words.text}</span>
        <span class="visually-hidden">
          {roomName}
          {words.spoken}
        </span>
      </span>
    );
  }

  const lineId = `${id}-line`;
  const captionId = `${id}-caption`;
  const unknown = shown.kind === 'unknown';
  const label = unknown ? `${strings.label(roomName)}${words.spoken}` : words.name;
  const start = shown.kind === 'unknown' ? (shown.limit ?? undefined) : shown.start;
  const mark = shown.kind === 'level' && shown.why !== 'plain' ? shown.now : undefined;
  return (
    <>
      <span class={cx(styles.level, open && styles.open)}>
        <Button
          kind="quiet"
          expanded={open}
          aria-label={label}
          aria-controls={open ? lineId : undefined}
          onClick={() => onOpenChange(!open)}
          {...dataAttributes(rest)}
        >
          {words.text}
        </Button>
      </span>
      {open && (
        <span id={lineId} class={styles.line}>
          <Slider
            label={strings.label(roomName)}
            value={start}
            mark={mark}
            readout={3}
            unknownText={strings.unknown(null)}
            valueText={() => words.valueText ?? words.text}
            onChange={onSet}
            aria-describedby={words.caption ? captionId : undefined}
          />
          {words.caption && (
            <span id={captionId} class={styles.caption}>
              {words.caption}
            </span>
          )}
        </span>
      )}
    </>
  );
}
