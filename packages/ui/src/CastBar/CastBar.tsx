import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { useAnnouncer } from '../Announcer';
import { Button } from '../Button';
import { NoticeLine } from '../NoticeLine';
import styles from './CastBar.module.css';

/** The CastBar's failure line: the cast or the add did not start. */
export interface CastBarFailure {
  /** The lead: "The cast did not start". */
  lead: string;
  /** The shipped sentence after it. */
  text?: string;
  /** Dismisses it; Cast is the retry. */
  onDismiss: () => void;
}

/** Props for {@link CastBar}. */
export interface CastBarProps {
  /**
   * cast: the filled Cast button. add: Cancel and the filled Add button, committing the
   * rooms chosen in a GroupVolume's add list.
   */
  mode: 'cast' | 'add';
  /** The Cast button's words: "Cast to 3 rooms" (it counts rooms), or "Cast" with none. */
  label: string;
  /** Its busy words: "Starting…". */
  busyLabel: string;
  /** Starts the cast; busy until it settles. */
  onCast: () => Promise<unknown>;
  /** Add mode: the words, the name and the actions. */
  add?: {
    /** "Add 2 rooms". */
    label: string;
    /** "Add 2 rooms to {{title}}". */
    name: string;
    /** Its busy words. */
    busyLabel?: string;
    /** Adds the rooms; busy until it settles. */
    onAdd: () => Promise<unknown>;
    /** "Cancel". */
    cancelLabel: string;
    /** Leaves add mode. */
    onCancel: () => void;
  };
  /**
   * The polite line, at most three sentences: which rooms leave their Sonos groups, whose
   * music starts again from the top, and the replace hint (with an older companion, which
   * rooms play too and the hint), or why Cast is disabled. With nothing to say there is no
   * line and no space kept for one; a line arrives with the notices' entrance, and grows the
   * bar only on a choice the user makes.
   */
  lines?: string[];
  /** A failure: a danger NoticeLine above the button, with X. */
  failure?: CastBarFailure;
  /** Disabled: nothing chosen, or not connected. */
  disabled?: boolean;
  /** The X's name ("Dismiss"). */
  dismissLabel?: string;
}

/**
 * Starts the cast (DESIGN.md C-castbar). It sits in the StickyActionBar, after the rooms it
 * acts on: a failure line (danger NoticeLine with X, said urgently) above the filled
 * the polite line, only while it has something to say, then the
 * full-width md button, "Cast to {{count}} rooms", busy "Starting…". The line is always
 * above Cast, in every state. Add mode is Cancel (outline) and "Add {{count}} rooms" (filled, `plus`). The line is
 * said by the Announcer once per change, never by a live region.
 * @param props - Component props
 * @param props.mode - cast or add
 * @param props.label - The Cast button's words
 * @param props.busyLabel - Its busy words
 * @param props.onCast - Starts the cast
 * @param props.add - Add mode
 * @param props.lines - The polite line
 * @param props.failure - A failure
 * @param props.disabled - Disabled
 * @param props.dismissLabel - The X's name
 * @returns The bar's content
 */
export function CastBar({
  mode,
  label,
  busyLabel,
  onCast,
  add,
  lines = [],
  failure,
  disabled = false,
  dismissLabel,
}: CastBarProps): JSX.Element {
  const { say } = useAnnouncer();
  const line = lines.slice(0, 3).join(' ');
  const said = useRef(line);
  useEffect(() => {
    if (said.current === line) return;
    said.current = line;
    if (line) say(line);
  }, [line, say]);

  return (
    <div class={styles.bar}>
      {failure && (
        <NoticeLine
          tone="danger"
          lead={failure.lead}
          text={failure.text}
          onDismiss={failure.onDismiss}
          dismissLabel={dismissLabel}
          urgent
        />
      )}
      {line && <p class={styles.line}>{line}</p>}
      {mode === 'add' && add ? (
        <div class={styles.add}>
          <Button kind="outline" size="md" onClick={add.onCancel}>
            {add.cancelLabel}
          </Button>
          <span class={styles.grow}>
            <Button
              kind="filled"
              size="md"
              icon="plus"
              fullWidth
              disabled={disabled}
              aria-label={add.name}
              onAction={add.onAdd}
              labels={{ busy: add.busyLabel }}
            >
              {add.label}
            </Button>
          </span>
        </div>
      ) : (
        <Button
          kind="filled"
          size="md"
          icon="cast"
          fullWidth
          disabled={disabled}
          onAction={onCast}
          labels={{ busy: busyLabel }}
        >
          {label}
        </Button>
      )}
    </div>
  );
}
