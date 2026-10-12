/*
 * The settings components (DESIGN.md §6) as the options page draws them, in the window's
 * density: SetList (C-setlist), live, and its empty state.
 */
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { Card } from '../../src/Card';
import { SetList, type SetListItem, type SetListStrings } from '../../src/SetList';
import { Toast } from '../../src/Toast';

const STRINGS: SetListStrings = {
  rename: 'Rename',
  renameNamed: (name) => `Rename ${name}`,
  remove: 'Remove',
  removeNamed: (name) => `Remove ${name}`,
  nameLabel: 'Name this set',
  save: 'Save',
  cancel: 'Cancel',
  emptyTitle: 'No sets yet',
  emptyBody:
    'Choose some rooms in the popup and save them as a set. They turn up here, to be renamed or thrown out.',
};

const SETS: SetListItem[] = [
  { id: 'evenings', name: 'Evenings', trail: '3 rooms' },
  { id: 'downstairs', name: 'Downstairs', trail: '2 rooms' },
  { id: 'long', name: 'Everything loud, with a name that goes on for a while', trail: '1 room' },
];

/**
 * A live SetList: Rename in place (an empty name is refused), Remove at once with the Toast's
 * Undo putting the set back where it was.
 * @returns The list in its card, and the Toast under it
 */
function LiveSetList(): JSX.Element {
  const [sets, setSets] = useState(SETS);
  const [removed, setRemoved] = useState<{ set: SetListItem; index: number } | null>(null);
  return (
    <div class="stack">
      <Card title="Saved sets">
        <SetList
          sets={sets}
          onRename={async (id, name) => {
            if (!name.trim()) return 'A set needs a name.';
            setSets((prev) => prev.map((s) => (s.id === id ? { ...s, name: name.trim() } : s)));
            setRemoved(null);
            return undefined;
          }}
          onRemove={(id) => {
            const index = sets.findIndex((s) => s.id === id);
            setRemoved({ set: sets[index], index });
            setSets((prev) => prev.filter((s) => s.id !== id));
          }}
          strings={STRINGS}
        />
      </Card>
      {removed && (
        <Toast
          text={`${removed.set.name} removed.`}
          action={{
            label: 'Undo',
            onClick: () => {
              setSets((prev) => {
                const next = [...prev];
                next.splice(removed.index, 0, removed.set);
                return next;
              });
              setRemoved(null);
            },
          }}
          onDismiss={() => setRemoved(null)}
        />
      )}
    </div>
  );
}

/**
 * SetList: the saved sets with Rename and Remove, live; and the list with no sets.
 * @returns The specimen
 */
export function SetListSpecimen(): JSX.Element {
  return (
    <div class="stack" data-density="desktop">
      <p class="label">live: Rename in place, Remove at once with Undo</p>
      <LiveSetList />
      <p class="label">no sets</p>
      <Card title="Saved sets">
        <SetList sets={[]} onRename={async () => undefined} onRemove={() => {}} strings={STRINGS} />
      </Card>
    </div>
  );
}
