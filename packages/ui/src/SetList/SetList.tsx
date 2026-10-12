import type { JSX } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Button } from '../Button';
import { EmptyState } from '../EmptyState';
import { Field } from '../Field';
import { TextInput } from '../TextInput';
import { useFocusKeeper } from '../utils/focus';
import styles from './SetList.module.css';

/** One saved set, as the list shows it. */
export interface SetListItem {
  /** Its id. */
  id: string;
  /** Its name. */
  name: string;
  /** Its room count: "3 rooms". */
  trail: string;
}

/** The SetList's words. */
export interface SetListStrings {
  /** "Rename". */
  rename: string;
  /** "Rename {{name}}": Rename's name. */
  renameNamed: (name: string) => string;
  /** "Remove". */
  remove: string;
  /** "Remove {{name}}": Remove's name. */
  removeNamed: (name: string) => string;
  /** The name field's label: "Name this set". */
  nameLabel: string;
  /** "Save". */
  save: string;
  /** "Cancel". */
  cancel: string;
  /** The empty state's title. */
  emptyTitle?: string;
  /** The empty state's words: where sets come from. */
  emptyBody: string;
}

/** Props for {@link SetList}. */
export interface SetListProps {
  /** The saved sets, oldest first. Last cast and Everywhere are not listed. */
  sets: SetListItem[];
  /**
   * Renames a set. Resolves to the error to show ("A set needs a name.") when the name is not
   * taken, else to nothing, and the row goes back to rest.
   */
  onRename: (id: string, name: string) => Promise<string | undefined>;
  /** Removes a set at once; the caller's Toast offers Undo. */
  onRemove: (id: string) => void;
  /** The words. */
  strings: SetListStrings;
}

/**
 * The saved sets (DESIGN.md C-setlist), for Settings › Saved sets: a row per set (its name,
 * "{{count}} rooms", then Rename and Remove as quiet Buttons), or an EmptyState when there
 * are none. Rename opens the name field in place, with Cancel and Save; an empty name is an
 * error (P-forms), and Escape is Cancel. Remove takes effect at once, with no confirm: the page's Toast offers
 * Undo. Focus follows: Rename lands on the field (its name selected), Cancel and Save go back
 * to Rename, and a removed row hands focus to the next control.
 * @param props - Component props
 * @param props.sets - The saved sets
 * @param props.onRename - Renames one
 * @param props.onRemove - Removes one
 * @param props.strings - The words
 * @returns The list, or its empty state
 */
export function SetList({ sets, onRename, onRemove, strings }: SetListProps): JSX.Element {
  const ref = useRef<HTMLUListElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const shown = useRef<string | null>(null);
  useFocusKeeper(ref);

  // Focus follows the form (WCAG 2.4.3, P-forms): opening it lands on the name, selected;
  // closing it goes back to that row's Rename.
  useLayoutEffect(() => {
    const list = ref.current;
    if (!list || shown.current === editing) return;
    const was = shown.current;
    shown.current = editing;
    if (editing) {
      const input = list.querySelector<HTMLInputElement>(
        `[data-set="${CSS.escape(editing)}"] input`,
      );
      input?.focus();
      input?.select();
    } else if (was) {
      list
        .querySelector<HTMLElement>(`[data-set="${CSS.escape(was)}"] button[data-action="rename"]`)
        ?.focus();
    }
  });

  if (sets.length === 0) {
    return <EmptyState title={strings.emptyTitle} body={strings.emptyBody} />;
  }

  const open = (set: SetListItem): void => {
    setEditing(set.id);
    setName(set.name);
    setError(undefined);
  };
  const close = (): void => {
    setEditing(null);
    setError(undefined);
  };

  return (
    <ul ref={ref} class={styles.list}>
      {sets.map((set) =>
        editing === set.id ? (
          <li key={set.id} class={styles.row} data-set={set.id}>
            <form
              class={styles.form}
              noValidate
              onKeyDown={(event) => {
                // Escape is Cancel, and goes no further (the Toast also takes it).
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                close();
              }}
              onSubmit={async (event) => {
                event.preventDefault();
                if (busy) return;
                setBusy(true);
                const problem = await onRename(set.id, name).finally(() => setBusy(false));
                if (problem) {
                  setError(problem);
                  ref.current
                    ?.querySelector<HTMLElement>(`[data-set="${CSS.escape(set.id)}"] input`)
                    ?.focus();
                } else close();
              }}
            >
              <Field label={strings.nameLabel} error={error}>
                {(control) => (
                  <TextInput
                    {...control}
                    value={name}
                    onInput={(value) => {
                      setName(value);
                      if (error && value.trim()) setError(undefined);
                    }}
                    invalid={Boolean(error)}
                  />
                )}
              </Field>
              <div class={styles.actions}>
                <Button kind="quiet" onClick={close}>
                  {strings.cancel}
                </Button>
                <Button kind="tonal" type="submit">
                  {strings.save}
                </Button>
              </div>
            </form>
          </li>
        ) : (
          <li key={set.id} class={styles.row} data-set={set.id}>
            <span class={styles.text}>
              <span class={styles.name}>{set.name}</span>
              <span class={styles.trail}>{set.trail}</span>
            </span>
            <span class={styles.actions}>
              <Button
                kind="quiet"
                aria-label={strings.renameNamed(set.name)}
                data-action="rename"
                onClick={() => open(set)}
              >
                {strings.rename}
              </Button>
              <Button
                kind="quiet"
                aria-label={strings.removeNamed(set.name)}
                data-action="remove"
                onClick={() => onRemove(set.id)}
              >
                {strings.remove}
              </Button>
            </span>
          </li>
        ),
      )}
    </ul>
  );
}
