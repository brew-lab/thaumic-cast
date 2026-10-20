/*
 * The settings components (DESIGN.md §6) as the options page and the desktop draw them, in
 * the window's density: SettingsSection (C-section) framed in every range, and SetList
 * (C-setlist), live, and its empty state.
 */
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { Button } from '../../src/Button';
import { Card } from '../../src/Card';
import { ChoiceGroup } from '../../src/ChoiceGroup';
import { DescriptionList } from '../../src/DescriptionList';
import { Disclosure } from '../../src/Disclosure';
import { Notice } from '../../src/Notice';
import { Select } from '../../src/Select';
import { SetList, type SetListItem, type SetListStrings } from '../../src/SetList';
import { SettingsRow } from '../../src/SettingsRow';
import { SettingsSection } from '../../src/SettingsSection';
import { Slider } from '../../src/Slider';
import { Switch } from '../../src/Switch';
import { Toast } from '../../src/Toast';
import { Frames } from './containers';

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
    'Choose some rooms in the popup and save them as a set. They turn up here, to be renamed or removed.',
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

/* --------------------------------------------------------------- SettingsSection */

const noop = (): void => {};

const QUALITY = [
  { value: 'low', label: 'Economical', description: 'The least network.' },
  { value: 'mid', label: 'Sensible', description: 'Neither extravagant nor mean.' },
  {
    value: 'high',
    label: 'Luxurious',
    description: 'Every bit, whether or not anyone can hear it.',
  },
  { value: 'custom', label: 'Bespoke', description: 'Every choice is yours.' },
] as const;

/**
 * One narrow Select row, named and described by its row.
 * @param props - The row
 * @param props.label - The setting's name
 * @param props.value - The chosen option
 * @param props.options - The options
 * @param props.help - What it does
 * @returns The row
 */
function SelectRow({
  label,
  value,
  options,
  help,
}: {
  label: string;
  value: string;
  options: string[];
  help?: string;
}): JSX.Element {
  return (
    <SettingsRow
      label={label}
      help={help}
      control={(a11y) => (
        <Select
          label={label}
          hideLabel
          value={value}
          options={options.map((o) => ({ value: o, label: o }))}
          onChange={noop}
          aria-describedby={a11y['aria-describedby']}
        />
      )}
    />
  );
}

/**
 * The options page's Audio section in Bespoke: a ChoiceGroup, an info Notice, a subheading
 * over four Select rows, a warning Notice, a wide row, then Advanced open with its own rows.
 * @returns The section
 */
function AudioSection(): JSX.Element {
  const [quality, setQuality] = useState<(typeof QUALITY)[number]['value']>('custom');
  return (
    <SettingsSection title="Audio" headingLevel={3}>
      <ChoiceGroup
        legend="Quality"
        value={quality}
        onChange={setQuality}
        options={QUALITY.map((q) => ({ ...q }))}
      />
      <Notice
        tone="info"
        text="Browser-wide capture is on, and it casts PCM whatever is chosen here."
        announce={false}
      />
      <h3>For the next tab cast</h3>
      <SelectRow label="Codec" value="AAC-LC" options={['AAC-LC', 'Opus', 'PCM']} />
      <SelectRow label="Bitrate" value="192 kbps" options={['128 kbps', '192 kbps']} />
      <SelectRow label="Channels" value="Stereo" options={['Stereo', 'Mono']} />
      <SelectRow label="Sample rate" value="48 kHz" options={['44.1 kHz', '48 kHz']} />
      <DescriptionList
        kind="readout"
        rows={[
          { key: 'head', term: 'Speaker head start', value: '250 ms, set in the desktop app' },
          { key: 'delay', term: 'Added delay', value: 'About 450 ms' },
        ]}
      />
      <p>PCM goes out at the rate the browser captures it, usually 48 kHz.</p>
      <Notice
        tone="warning"
        text="This browser will not encode that combination, so a tab cast set to it will not start."
        announce={false}
      />
      <SettingsRow
        label="When the connection falls behind"
        controlWidth="wide"
        help="Letting delay grow keeps the audio whole; skipping ahead keeps the delay short."
        control={(a11y) => (
          <Select
            label="When the connection falls behind"
            hideLabel
            value="quality"
            options={[
              { value: 'quality', label: 'Let delay grow (up to a limit)' },
              { value: 'realtime', label: 'Skip ahead' },
            ]}
            onChange={noop}
            aria-describedby={a11y['aria-describedby']}
          />
        )}
      />
      <Disclosure label="Advanced" defaultOpen>
        <SelectRow
          label="Smoothing"
          value="200 ms (default)"
          options={['100 ms', '200 ms (default)', '400 ms']}
          help="Audio is held briefly at the companion so the late pieces can catch up."
        />
        <SelectRow
          label="Frame size"
          value="10 ms (default)"
          options={['10 ms (default)', '20 ms']}
          help="How much audio the browser puts in each message to the companion."
        />
      </Disclosure>
    </SettingsSection>
  );
}

/**
 * Finer points: Switch rows, the first with its detail Slider; one locked by another.
 * @returns The section
 */
function FinerPointsSection(): JSX.Element {
  const [ceiling, setCeiling] = useState(true);
  const [level, setLevel] = useState(30);
  const [sync, setSync] = useState(true);
  return (
    <SettingsSection title="Finer points" headingLevel={3}>
      <SettingsRow
        control={
          <Switch
            label="Start no louder than"
            description="A cast starts at the level the room is already at, turned down to this if it is higher."
            checked={ceiling}
            onChange={setCeiling}
          />
        }
        detail={
          ceiling && (
            <Slider
              label="Start no louder than"
              min={0}
              max={100}
              value={level}
              onChange={setLevel}
              readout={3}
            />
          )
        }
      />
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
        note="Browser-wide capture is on, so there is nothing here to keep awake."
        checked={false}
        onChange={noop}
        disabled
      />
    </SettingsSection>
  );
}

/**
 * The desktop Server's actions: three action rows whose Buttons fill the shared track, so
 * all three are as wide as the widest.
 * @returns The section
 */
function ActionsSection(): JSX.Element {
  return (
    <SettingsSection title="Actions" headingLevel={3}>
      <SettingsRow
        label="Restart the server"
        controlWidth="action"
        help="Stops every cast and starts the server again."
        control={
          <Button kind="tonal" icon="refresh">
            Restart
          </Button>
        }
      />
      <SettingsRow
        label="Disconnect extensions"
        controlWidth="action"
        help="Every browser connected to this computer has to connect again."
        control={<Button kind="outline">Disconnect</Button>}
      />
      <SettingsRow
        label="Stop all casts"
        controlWidth="action"
        help="Every speaker stops playing what this computer sends."
        control={
          <Button kind="filled" danger icon="stop">
            Stop
          </Button>
        }
      />
    </SettingsSection>
  );
}

/**
 * Saved sets: a line under the heading, and the empty list without its own block padding.
 * @returns The section
 */
function SetsSection(): JSX.Element {
  return (
    <SettingsSection
      title="Saved sets"
      headingLevel={3}
      description="Kept on this device. Make one in the popup with Save these rooms as a set."
    >
      <SetList sets={[]} onRename={async () => undefined} onRemove={noop} strings={STRINGS} />
    </SettingsSection>
  );
}

/**
 * SettingsSection: one subgrid and its rules, framed compact, medium and wide in both
 * densities: Audio (Bespoke, Advanced open), Finer points, the desktop Server's actions
 * and an empty Saved sets.
 * @returns The specimen
 */
export function SettingsSectionSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <Frames title="Audio, Bespoke, Advanced open">{() => <AudioSection />}</Frames>
      <Frames title="Finer points">{() => <FinerPointsSection />}</Frames>
      <Frames title="Actions (the desktop Server)">{() => <ActionsSection />}</Frames>
      <Frames title="Saved sets, empty">{() => <SetsSection />}</Frames>
    </div>
  );
}
