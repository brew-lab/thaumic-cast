import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { useAnnouncer } from '../Announcer';
import { Button } from '../Button';
import { Disclosure } from '../Disclosure';
import { Divider } from '../Divider';
import { EmptyState } from '../EmptyState';
import { Field } from '../Field';
import type { GlyphName } from '../Icon/glyphs';
import { RoomRow, type RoomRowPickProps } from '../RoomRow';
import type { StartLevelStrings } from '../StartLevel/start';
import { TextInput } from '../TextInput';
import { SEARCH_SETTLE_MS } from '../tokens';
import { filterRooms } from './filter';
import styles from './RoomPicker.module.css';

/** One room in the picker, as a RoomRow `pick` takes it. */
export type PickerRoom = Omit<RoomRowPickProps, 'mode' | 'strings' | 'index'>;

/** One set: Last cast, a saved set, or Everywhere. Sets live on this device only. */
export interface PickerSet {
  /** Its id. */
  id: string;
  /** Its name: "Last cast", "Evenings", "Everywhere". */
  name: string;
  /** last (`history`), saved (`bookmark`) or everywhere (`home`, from 3 rooms). */
  kind: 'last' | 'saved' | 'everywhere';
  /** The room count at the row's end: "3 rooms". */
  trail?: string;
  /** Reads pressed while the choice equals the set. */
  pressed: boolean;
  /** A room of the set does not answer: "Garden is not answering; Study goes alone." */
  description?: string;
}

/** The inline "Save these rooms as a set" form. */
export interface PickerSave {
  /** Offered: two or more rooms chosen that equal no set. */
  shown: boolean;
  /** The form is open. */
  open: boolean;
  /** The name typed so far. */
  name: string;
  /** "A set needs a name.", after a save with no name. */
  error?: string;
  /** Opens the form. */
  onOpen: () => void;
  /** Called as the name is typed. */
  onName: (name: string) => void;
  /** Saves the set. */
  onSave: () => void;
  /** Shuts the form. */
  onCancel: () => void;
}

/** The words RoomPicker needs, from the app's locale. */
export interface RoomPickerStrings {
  /** `target_speaker`: "Cast to", the fieldset's legend. */
  legend: string;
  /** `rooms_label`: "Rooms", the fold's label. */
  rooms: string;
  /** `rooms_chosen`: "{{count}} of {{total}} chosen", the fold's summary. */
  chosen: (count: number, total: number) => string;
  /** `rooms_count_*`: "{{count}} rooms", said once typing stops. */
  roomsCount: (count: number) => string;
  /** `find_room`: "Find a room", the search's hidden label. */
  findRoom: string;
  /** `clear_search`: "Clear search". */
  clearSearch: string;
  /** `hidden_chosen_*`: "2 chosen rooms are hidden by the search, and still chosen." */
  hiddenChosen: (count: number) => string;
  /** `save_set`: "Save these rooms as a set". */
  saveSet: string;
  /** `name_set`: "Name this set". */
  nameSet: string;
  /** `save`: "Save". */
  save: string;
  /** `cancel`: "Cancel". */
  cancel: string;
  /** `picker_waiting`: "Speakers are listed here once the companion answers." */
  waiting: string;
  /** `no_speakers_found`. */
  empty: string;
  /** `loading_speakers`: "Asking for speakers…". */
  loading: string;
  /** The rows' start levels. */
  start: StartLevelStrings;
}

/** Props for {@link RoomPicker}. */
export interface RoomPickerProps {
  /** Every room, sorted by name. */
  rooms: PickerRoom[];
  /** The sets: Last cast, the saved sets, and Everywhere from 3 rooms. */
  sets: PickerSet[];
  /** A set was pressed: the choice becomes the set. */
  onSet: (id: string) => void;
  /** From this many rooms the rooms fold (8). */
  foldFrom?: number;
  /** The rooms fold is open. */
  foldOpen: boolean;
  /** Opens or shuts the rooms fold. */
  onFoldChange: (open: boolean) => void;
  /** The search, inside the open fold. */
  query: string;
  /** Called as the search is typed. */
  onQuery: (query: string) => void;
  /** "Save these rooms as a set" and its form. */
  save?: PickerSave;
  /**
   * ready; loading (header checking, rooms not in yet); empty (no speaker answered);
   * disconnected (the fieldset is disabled, and says why).
   */
  state: 'ready' | 'loading' | 'empty' | 'disconnected';
  /** The words. */
  strings: RoomPickerStrings;
}

const SET_GLYPH: Record<PickerSet['kind'], GlyphName> = {
  last: 'history',
  saved: 'bookmark',
  everywhere: 'home',
};

/**
 * Where to cast (DESIGN.md C-picker, P-picker model B): a fieldset "Cast to", sets first
 * (quiet md Buttons, `pressed` while the choice equals them), a Divider, then RoomRow `pick`
 * per room. From 8 rooms the rooms fold: shut shows the chosen rooms only; open adds the
 * search and every room. The search filters and never unticks, and counts the chosen rooms
 * it hides in one line under the list. "Save these rooms as a set" opens an inline form. Not
 * connected, the fieldset is disabled (drawing everything in it disabled) and says why.
 * Nothing scrolls inside it: long content folds in place.
 * @param props - Component props
 * @param props.rooms - Every room
 * @param props.sets - The sets
 * @param props.onSet - A set was pressed
 * @param props.foldFrom - From this many rooms the rooms fold
 * @param props.foldOpen - The fold is open
 * @param props.onFoldChange - Opens or shuts the fold
 * @param props.query - The search
 * @param props.onQuery - Called as the search is typed
 * @param props.save - Save these rooms as a set
 * @param props.state - ready, loading, empty or disconnected
 * @param props.strings - The words
 * @returns The picker
 */
export function RoomPicker({
  rooms,
  sets,
  onSet,
  foldFrom = 8,
  foldOpen,
  onFoldChange,
  query,
  onQuery,
  save,
  state,
  strings,
}: RoomPickerProps): JSX.Element {
  const { say } = useAnnouncer();
  const folds = rooms.length >= foldFrom;
  const searching = folds && foldOpen;
  const { shown, hiddenChosen } = filterRooms(rooms, searching ? query : '');
  const chosen = rooms.filter((r) => r.checked);

  // A set just saved takes the form's place, pressed: focus goes to it (WCAG 2.4.3).
  const pickerRef = useRef<HTMLFieldSetElement>(null);
  const saveShown = save?.shown ?? false;
  const wasShown = useRef(saveShown);
  useLayoutEffect(() => {
    const was = wasShown.current;
    wasShown.current = saveShown;
    const picker = pickerRef.current;
    if (!was || saveShown || !picker || !focusLost(picker)) return;
    picker.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
  }, [saveShown]);

  // After typing stops, say how many rooms the search shows (never on open).
  const typed = useRef(query);
  useEffect(() => {
    if (typed.current === query) return;
    typed.current = query;
    if (!searching || !query.trim()) return;
    const timer = setTimeout(() => say(strings.roomsCount(shown.length)), SEARCH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [query, searching, shown.length]);

  const list = (items: PickerRoom[]): JSX.Element => (
    <div class={styles.rooms}>
      {items.map((r, i) => (
        <RoomRow key={r.room.id} mode="pick" {...r} strings={strings.start} index={i + 1} />
      ))}
    </div>
  );

  let body: JSX.Element;
  if (state === 'loading') {
    body = <EmptyState kind="searching" body={strings.loading} />;
  } else if (state === 'empty') {
    body = <EmptyState kind="empty" body={strings.empty} />;
  } else if (state === 'disconnected') {
    body = <EmptyState kind="offline" body={strings.waiting} />;
  } else {
    body = (
      <>
        {sets.length > 0 && (
          <>
            <div class={styles.sets}>
              {sets.map((set) => (
                <Button
                  key={set.id}
                  kind="quiet"
                  size="md"
                  align="start"
                  fullWidth
                  icon={SET_GLYPH[set.kind]}
                  trail={set.trail}
                  pressed={set.pressed}
                  description={set.description}
                  onClick={() => onSet(set.id)}
                >
                  {set.name}
                </Button>
              ))}
            </div>
            <Divider />
          </>
        )}
        {folds ? (
          <>
            <Disclosure
              size="md"
              label={strings.rooms}
              summary={strings.chosen(chosen.length, rooms.length)}
              open={foldOpen}
              onOpenChange={onFoldChange}
            >
              <div class={styles.search}>
                <TextInput
                  kind="search"
                  label={strings.findRoom}
                  clearLabel={strings.clearSearch}
                  value={query}
                  onInput={onQuery}
                />
              </div>
              {list(shown)}
              {hiddenChosen > 0 && (
                <p class={styles.hidden}>{strings.hiddenChosen(hiddenChosen)}</p>
              )}
            </Disclosure>
            {!foldOpen && chosen.length > 0 && list(chosen)}
          </>
        ) : (
          list(rooms)
        )}
        {save?.shown && <SaveSet save={save} strings={strings} />}
      </>
    );
  }

  return (
    <fieldset
      ref={pickerRef}
      class={styles.picker}
      disabled={state === 'disconnected'}
      aria-busy={state === 'loading' ? 'true' : undefined}
    >
      <legend class={styles.legend}>{strings.legend}</legend>
      {body}
    </fieldset>
  );
}

/**
 * "Save these rooms as a set": a link Button that opens an inline form, the name field with
 * its error, then Cancel and Save.
 * @param props - Component props
 * @param props.save - The form's state and actions
 * @param props.strings - The words
 * @returns The offer, or the form
 */
function SaveSet({ save, strings }: { save: PickerSave; strings: RoomPickerStrings }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(save.open);
  // Focus follows the form (WCAG 2.4.3, P-forms): opening it lands on the name; Cancel goes
  // back to the offer; a save with no name lands on the name, which says why.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || wasOpen.current === save.open) return;
    wasOpen.current = save.open;
    if (save.open) root.querySelector<HTMLElement>('input')?.focus();
    else if (focusLost(root)) root.querySelector<HTMLElement>('button')?.focus();
  });
  if (!save.open) {
    return (
      <div ref={ref} class={styles.save}>
        <Button kind="link" onClick={save.onOpen}>
          {strings.saveSet}
        </Button>
      </div>
    );
  }
  return (
    <div ref={ref}>
      <form
        class={styles.form}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          save.onSave();
          // Once the save has drawn its answer, an invalid name takes focus (P-forms).
          requestAnimationFrame(() => {
            ref.current?.querySelector<HTMLElement>('input[aria-invalid="true"]')?.focus();
          });
        }}
      >
        <Field label={strings.nameSet} error={save.error}>
          {(control) => (
            <TextInput
              {...control}
              value={save.name}
              onInput={save.onName}
              invalid={Boolean(save.error)}
            />
          )}
        </Field>
        <div class={styles.formActions}>
          <Button kind="quiet" onClick={save.onCancel}>
            {strings.cancel}
          </Button>
          <Button kind="tonal" type="submit">
            {strings.save}
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * Whether focus was lost: it sits on nothing, or on the page's body.
 * @param el - Any element in the document
 * @returns True when nothing has focus
 */
function focusLost(el: Element): boolean {
  const active = el.ownerDocument.activeElement;
  return !active || active === el.ownerDocument.body;
}
