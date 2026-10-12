import type { JSX } from 'preact';
import { useTranslation } from 'react-i18next';
import { Card, SetList } from '@thaumic-cast/ui';
import type { RemovedSet } from '../../lib/room-sets';
import type { SavedSetsResult } from '../hooks/useSavedSets';

interface SetsSectionProps {
  /** The saved sets and their actions. */
  saved: SavedSetsResult;
  /** Called with a set once it is removed, so the page's Toast can offer Undo. */
  onRemoved: (removed: RemovedSet) => void;
  /** Called on any other change, which ends the Toast. */
  onChange: () => void;
}

/**
 * Settings › Saved sets: the sets saved in the popup, each with Rename and Remove (C-setlist).
 * Remove is at once; the page's Toast offers Undo. Last cast and Everywhere are not listed.
 * @param props - Component props
 * @param props.saved - The saved sets and their actions
 * @param props.onRemoved - Called with a removed set
 * @param props.onChange - Called on a rename
 * @returns The section
 */
export function SetsSection({ saved, onRemoved, onChange }: SetsSectionProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <Card title={t('sets_section_title')}>
      <SetList
        sets={saved.sets.saved.map((set) => ({
          id: set.id,
          name: set.name,
          trail: t('rooms_count', { count: set.rooms.length }),
        }))}
        onRename={async (id, name) => {
          onChange();
          const error = await saved.rename(id, name);
          return error ? t(error) : undefined;
        }}
        onRemove={(id) => {
          void saved.remove(id).then((removed) => {
            if (removed) onRemoved(removed);
          });
        }}
        strings={{
          rename: t('set_rename'),
          renameNamed: (name) => t('set_rename_named', { name }),
          remove: t('set_remove'),
          removeNamed: (name) => t('set_remove_named', { name }),
          nameLabel: t('name_set'),
          save: t('save'),
          cancel: t('cancel'),
          emptyTitle: t('sets_empty_title'),
          emptyBody: t('sets_empty_body'),
        }}
      />
    </Card>
  );
}
