import type { ComponentChildren, JSX } from 'preact';
import { StatusDot, type StatusDotState } from '../StatusDot';
import { cx } from '../utils/cx';
import styles from './DescriptionList.module.css';

/** One term and its value, for the readout and stat kinds. */
export interface DescriptionRow {
  /** A stable key. */
  key: string;
  /** The term: "Codec", "Address". */
  term: string;
  /** The value: words, a number, or a CopyField. */
  value: ComponentChildren;
  /** A number: tabular, in a `--ch-count` box (stat counts). */
  count?: boolean;
}

/** One line of the checklist kind: a state and the one sentence that says it. */
export interface ChecklistRow {
  /** A stable key. */
  key: string;
  /** connected: done; checking: still waiting (the Clacks); failed: none. */
  state: Exclude<StatusDotState, 'live'>;
  /** The sentence, which says the state in words: "Desktop app: running". */
  text: string;
}

/** Props for {@link DescriptionList}. */
export type DescriptionListProps =
  | {
      /**
       * readout: quiet terms and strong values ("For the next tab cast"). stat: strong
       * terms and larger values, counts in `--ch-count` boxes (the Server page).
       */
      kind: 'readout' | 'stat';
      /** The pairs. */
      rows: readonly DescriptionRow[];
      /** Names the list, when no heading does. */
      'aria-label'?: string;
    }
  | {
      /** checklist: a StatusDot and one sentence per line (the desktop Ready step). */
      kind: 'checklist';
      /** The lines. */
      rows: readonly ChecklistRow[];
      /** Names the list, when no heading does. */
      'aria-label'?: string;
    };

/**
 * Terms and values, or a short checklist (DESIGN.md M-dl). readout and stat are a real
 * `<dl>`; from 25rem of the `card` container the term and value share a row, and under it
 * each pair stacks, term over value. checklist is a list of sentences, each led by a
 * StatusDot whose shape repeats what the words say (never colour alone).
 * @param props - Component props
 * @param props.kind - readout, stat or checklist
 * @param props.rows - The rows
 * @returns The list
 */
export function DescriptionList(props: DescriptionListProps): JSX.Element {
  if (props.kind === 'checklist') {
    return (
      <ul class={styles.checklist} role="list" aria-label={props['aria-label']}>
        {props.rows.map((row) => (
          <li key={row.key} class={styles.check}>
            <span class={styles.mark}>
              <StatusDot state={row.state} size="md" />
            </span>
            <span>{row.text}</span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <dl class={cx(styles.list, styles[props.kind])} aria-label={props['aria-label']}>
      {props.rows.map((row) => (
        <div key={row.key} class={styles.pair}>
          <dt class={styles.term}>{row.term}</dt>
          <dd class={cx(styles.value, row.count && styles.count, row.count && 'num')}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
