/*
 * The page shells that own their document (DESIGN.md §8): OptionsShell. A shell whose
 * document is its scroller cannot be drawn inside the catalogue's own page, so it is drawn
 * in an iframe of this same catalogue with `?frame=options` (main.tsx renders the page
 * alone), at a narrow and a wide window, in the panel's scheme.
 */
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { AnnouncerProvider } from '../../src/Announcer';
import { EmptyState } from '../../src/EmptyState';
import { Notice } from '../../src/Notice';
import { OptionsShell } from '../../src/OptionsShell';
import { SegmentedControl } from '../../src/SegmentedControl';
import { SetList, type SetListItem } from '../../src/SetList';
import { SettingsRow } from '../../src/SettingsRow';
import { SettingsSection } from '../../src/SettingsSection';
import { Switch } from '../../src/Switch';
import { Toast } from '../../src/Toast';
import { useScheme } from '../scheme';

const SETS: SetListItem[] = [
  { id: 'evenings', name: 'Evenings', trail: '3 rooms' },
  { id: 'downstairs', name: 'Downstairs', trail: '2 rooms' },
];

const STRINGS = {
  rename: 'Rename',
  renameNamed: (name: string) => `Rename ${name}`,
  remove: 'Remove',
  removeNamed: (name: string) => `Remove ${name}`,
  nameLabel: 'Name this set',
  save: 'Save',
  cancel: 'Cancel',
  emptyTitle: 'No sets yet',
  emptyBody: 'Choose some rooms in the popup and save them as a set.',
};

const THEME = [
  { value: 'auto', label: 'Auto', glyph: 'contrast' },
  { value: 'light', label: 'Light', glyph: 'sun' },
  { value: 'dark', label: 'Dark', glyph: 'moon' },
] as const;

/**
 * The options page on its own, as the iframe draws it: `?frame=options`, with `&busy=1` for
 * the loading state and `&failed=1` for the page's save failure. Remove a set for the Toast.
 * @returns The page
 */
export function OptionsPageFrame(): JSX.Element {
  const params = new URLSearchParams(location.search);
  const busy = params.get('busy') === '1';
  const failed = params.get('failed') === '1';
  const [theme, setTheme] = useState<'auto' | 'light' | 'dark'>('auto');
  const [sync, setSync] = useState(true);
  const [awake, setAwake] = useState(false);
  const [sets, setSets] = useState(SETS);
  const [removed, setRemoved] = useState<{ set: SetListItem; index: number } | null>(null);
  return (
    <AnnouncerProvider>
      <OptionsShell
        title="Settings"
        busy={busy}
        notice={
          failed && (
            <Notice
              kind="banner"
              tone="danger"
              text="The settings were not saved. Try again."
              announce={false}
            />
          )
        }
        toast={
          removed && (
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
          )
        }
      >
        {busy ? (
          <EmptyState kind="searching" body="Loading settings…" />
        ) : (
          <>
            <SettingsSection title="Appearance">
              <SettingsRow
                label="Theme"
                controlWidth="wide"
                help="Light or dark, whichever the system is set to."
                control={(a11y) => (
                  <SegmentedControl
                    label="Theme"
                    hideLabel
                    value={theme}
                    onChange={setTheme}
                    options={THEME}
                    aria-describedby={a11y['aria-describedby']}
                  />
                )}
              />
            </SettingsSection>
            <SettingsSection title="Finer points">
              <Switch
                label="Video sync"
                description="Plays each page's sound early by as much as the speakers play late, so a film's lips and words arrive together. Pages already open need a reload, and a cast of the whole browser cannot be synced. PCM casts only."
                note="Takes effect when you next start a cast."
                checked={sync}
                onChange={setSync}
              />
              <Switch
                label="Keep the tab awake"
                description="Plays the tab's audio back on this computer, too quietly to hear."
                checked={awake}
                onChange={setAwake}
              />
            </SettingsSection>
            <SettingsSection
              title="Saved sets"
              description="Kept on this device. Make one in the popup with Save these rooms as a set."
            >
              <SetList
                sets={sets}
                onRename={async () => undefined}
                onRemove={(id) => {
                  const index = sets.findIndex((s) => s.id === id);
                  setRemoved({ set: sets[index], index });
                  setSets((prev) => prev.filter((s) => s.id !== id));
                }}
                strings={STRINGS}
              />
            </SettingsSection>
            <SettingsSection title="About">
              <p>Thaumic Cast Extension · Version 0.12.0</p>
            </SettingsSection>
          </>
        )}
      </OptionsShell>
    </AnnouncerProvider>
  );
}

/**
 * One window of the options page: an iframe of `?frame=options` in the panel's scheme.
 * @param props - Component props
 * @param props.width - The window's width in px
 * @param props.query - More of the query (`&busy=1`)
 * @param props.label - What the window shows
 * @returns The window
 */
function OptionsWindow({
  width,
  query = '',
  label,
}: {
  width: number;
  query?: string;
  label: string;
}): JSX.Element {
  const scheme = useScheme();
  return (
    <div class="stack">
      <p class="label">
        {label} · {width} px
      </p>
      <iframe
        class="page-frame"
        loading="lazy"
        style={{ '--page-frame-w': width }}
        title={`The options page, ${label}, ${scheme}`}
        src={`./?frame=options&theme=${scheme}${query}`}
      />
    </div>
  );
}

/**
 * OptionsShell: the page in a narrow and a wide window, failing to save, and loading.
 * @returns The specimen
 */
export function OptionsShellSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <OptionsWindow width={400} label="narrow" />
      <OptionsWindow width={760} label="wide" />
      <OptionsWindow width={760} query="&failed=1" label="the settings were not saved" />
      <OptionsWindow width={400} query="&busy=1" label="loading" />
    </div>
  );
}
