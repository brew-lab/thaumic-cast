import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { AddressField, type AddressResult } from '../../src/AddressField';
import { Button } from '../../src/Button';
import { Card } from '../../src/Card';
import { ChoiceGroup } from '../../src/ChoiceGroup';
import { Cluster } from '../../src/Cluster';
import { CopyField, type ClipboardEnv } from '../../src/CopyField';
import { DescriptionList } from '../../src/DescriptionList';
import { Disclosure } from '../../src/Disclosure';
import { EmptyState } from '../../src/EmptyState';
import { Field } from '../../src/Field';
import { Notice } from '../../src/Notice';
import { NoticeLine } from '../../src/NoticeLine';
import { PageHeader } from '../../src/PageHeader';
import { SegmentedControl } from '../../src/SegmentedControl';
import { Select } from '../../src/Select';
import { SettingsRow } from '../../src/SettingsRow';
import { Slider } from '../../src/Slider';
import { Switch } from '../../src/Switch';
import { TextInput } from '../../src/TextInput';
import { Toast } from '../../src/Toast';
import { WizardStep } from '../../src/WizardStep';
import { StateGrid, StateRow } from './atoms';

const noop = (): void => {};
const never = <T,>(): Promise<T> => new Promise<T>(() => {});

/**
 * Presses the first button inside it once, after mounting: draws a state that only a
 * press reaches (copied, refused, testing, failed) without a pointer.
 * @param props - Component props
 * @param props.children - The specimen
 * @param props.selector - Which button to press
 * @returns The specimen
 */
function Pressed({
  children,
  selector = 'button',
}: {
  children: ComponentChildren;
  selector?: string;
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>(selector)?.click();
  }, []);
  return <div ref={box}>{children}</div>;
}

/**
 * A clipboard that takes everything, or refuses everything.
 * @param accept - Whether it takes the text
 * @returns The fake clipboard
 */
const fakeClipboard = (accept: boolean): ClipboardEnv => ({
  clipboard: {
    write: () => (accept ? Promise.resolve() : Promise.reject(new Error('refused'))),
    writeText: () => (accept ? Promise.resolve() : Promise.reject(new Error('refused'))),
  },
});

/* ------------------------------------------------------------------- Field */

/**
 * Field: help, optional, a status in the help's place, and the error, at both densities.
 * @returns The specimen
 */
export function FieldSpecimen(): JSX.Element {
  const [name, setName] = useState('');
  const field = (props: Partial<Parameters<typeof Field>[0]>, value: string): JSX.Element => (
    <Field label="Name this set" {...props}>
      {(control) => (
        <TextInput
          {...control}
          value={value}
          onInput={noop}
          invalid={!!props.error}
          disabled={props.disabled}
          placeholder="Evenings"
        />
      )}
    </Field>
  );
  return (
    <div class="stack narrow">
      <Field label="Name this set" help="Kept on this device.">
        {(control) => (
          <TextInput {...control} value={name} onInput={setName} placeholder="Evenings" />
        )}
      </Field>
      {field({ optional: 'Optional', help: 'Only an optional field is marked.' }, '')}
      {field({ help: 'The help…', status: 'A status takes the help’s place.' }, 'Evenings')}
      {field({ help: 'The help…', error: 'A set needs a name.' }, '')}
      {field({ disabled: true, help: 'Disabled: the help stays readable.' }, '')}
      <div data-density="desktop" class="stack">
        {field({ help: 'Desktop density: a 14 px label.' }, 'Evenings')}
        {field({ error: 'A set needs a name.' }, '')}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- SettingsRow */

const THEME = [
  { value: 'auto', label: 'Auto', glyph: 'contrast' },
  { value: 'light', label: 'Light', glyph: 'sun' },
  { value: 'dark', label: 'Dark', glyph: 'moon' },
] as const;

/**
 * The rows of one settings card: narrow, wide and action controls, a Switch with its
 * detail slot, disabled, locked and error.
 * @returns The rows
 */
export function SettingsRows(): JSX.Element {
  const [theme, setTheme] = useState<'auto' | 'light' | 'dark'>('auto');
  const [ceiling, setCeiling] = useState(true);
  const [level, setLevel] = useState(30);
  return (
    <>
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
      <SettingsRow
        label="Speaker head start"
        help="Audio handed to each speaker in advance, so it has something to be getting on with when the Wi-Fi stalls."
        control={(a11y) => (
          <Select
            label="Speaker head start"
            hideLabel
            value={250}
            options={[
              { value: 0, label: 'Off' },
              { value: 250, label: '250 ms' },
              { value: 500, label: '500 ms' },
            ]}
            onChange={noop}
            aria-describedby={a11y['aria-describedby']}
          />
        )}
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
      <SettingsRow
        label="Restart Thaumic Cast"
        controlWidth="action"
        help="Stops every cast and starts the server again."
        control={
          <Button icon="refresh" size="sm">
            Restart
          </Button>
        }
      />
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
              step={1}
              value={level}
              onChange={setLevel}
              readout={3}
            />
          )
        }
      />
      <SettingsRow
        label="Speaker head start"
        disabled
        help="Audio handed to each speaker in advance."
        note="Needs speaker monitoring, which is where the numbers come from."
        control={(a11y) => (
          <Select
            label="Speaker head start"
            hideLabel
            value={250}
            options={[{ value: 250, label: '250 ms' }]}
            onChange={noop}
            disabled
            aria-describedby={a11y['aria-describedby']}
          />
        )}
      />
      <SettingsRow
        label="Speaker head start"
        locked
        help="Audio handed to each speaker in advance."
        note="THAUMIC_HEAD_START sets this to 500 ms, and an environment variable outranks a setting."
        control={(a11y) => (
          <Select
            label="Speaker head start"
            hideLabel
            value={500}
            options={[{ value: 500, label: '500 ms' }]}
            onChange={noop}
            disabled
            aria-describedby={a11y['aria-describedby']}
          />
        )}
      />
      <SettingsRow
        label="Theme"
        controlWidth="wide"
        error="The settings were not saved. Try again."
        control={(a11y) => (
          <SegmentedControl
            label="Theme (error)"
            hideLabel
            value="dark"
            onChange={noop}
            options={THEME}
            aria-describedby={a11y['aria-describedby']}
          />
        )}
      />
    </>
  );
}

/**
 * SettingsRow in a compact, a medium and a wide card, on the desktop density.
 * @returns The specimen
 */
export function SettingsRowSpecimen(): JSX.Element {
  return (
    <div class="stack" data-density="desktop">
      <p class="label">Compact (a card under 25rem)</p>
      <div class="width-compact">
        <Card title="Audio" level={3}>
          <SettingsRows />
        </Card>
      </div>
      <p class="label">Medium (25 to 45rem)</p>
      <div class="width-medium">
        <Card title="Audio" level={3}>
          <SettingsRows />
        </Card>
      </div>
      <p class="label">Wide (from 45rem)</p>
      <Card title="Audio" level={3}>
        <SettingsRows />
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------- ChoiceGroup */

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
 * ChoiceGroup: Companion (legend hidden) and Quality, compact and medium, disabled.
 * @returns The specimen
 */
export function ChoiceGroupSpecimen(): JSX.Element {
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [quality, setQuality] = useState<(typeof QUALITY)[number]['value']>('high');
  return (
    <div class="stack" data-density="desktop">
      <div class="width-medium">
        <Card title="Companion" level={3}>
          <ChoiceGroup
            legend="Companion"
            legendHidden
            value={mode}
            onChange={setMode}
            options={[
              {
                value: 'auto',
                label: 'Find it automatically',
                description: 'Looks on this computer for the desktop app or a server.',
              },
              {
                value: 'manual',
                label: 'Enter the address',
                description: 'For a server on another machine, or an unusual port.',
              },
            ]}
          />
        </Card>
      </div>
      <div class="width-medium">
        <Card title="Audio" level={3}>
          <ChoiceGroup legend="Quality" value={quality} onChange={setQuality} options={QUALITY} />
        </Card>
      </div>
      <div class="width-compact">
        <Card title="Audio (compact)" level={3}>
          <ChoiceGroup legend="Quality" value="mid" onChange={noop} options={QUALITY} disabled />
        </Card>
      </div>
      <div data-density="popup" class="width-compact">
        <Card>
          <ChoiceGroup legend="Quality (popup)" value="low" onChange={noop} options={QUALITY} />
        </Card>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- CopyField */

const URL = 'http://192.168.1.20:49400/stream/4f2a/live.flac';

/**
 * CopyField: rest, copied (held here; in use it shows for COPY_CONFIRM_MS), refused (revealed and selected), unavailable, the
 * icon-only action under 20rem, and the reveal-on-refusal kind.
 * @returns The specimen
 */
export function CopyFieldSpecimen(): JSX.Element {
  const words = {
    done: 'Copied',
    refusedNote: 'The clipboard said no. Here it is, selected, to copy by hand.',
    unavailableNote: "This computer's address isn't known yet. Try again in a moment.",
  };
  return (
    <div class="stack" data-density="desktop">
      <div class="copy-states">
        <div class="stack">
          <p class="label">rest</p>
          <div class="width-medium">
            <CopyField value="192.168.1.20:49400" action="Copy address" {...words} />
          </div>
        </div>
        <div class="stack">
          <p class="label">copied</p>
          <div class="width-medium">
            <Pressed>
              <CopyField
                value="192.168.1.20:49400"
                action="Copy address"
                clipboard={fakeClipboard(true)}
                confirmFor={Infinity}
                {...words}
              />
            </Pressed>
          </div>
        </div>
        <div class="stack">
          <p class="label">copied, then back to rest after 2 s (press it)</p>
          <div class="width-medium">
            <CopyField
              value="192.168.1.20:49400"
              action="Copy address"
              clipboard={fakeClipboard(true)}
              {...words}
            />
          </div>
        </div>
        <div class="stack">
          <p class="label">refused</p>
          <div class="width-medium">
            <Pressed>
              <CopyField
                value="192.168.1.20:49400"
                action="Copy address"
                clipboard={fakeClipboard(false)}
                {...words}
              />
            </Pressed>
          </div>
        </div>
        <div class="stack">
          <p class="label">unavailable</p>
          <div class="width-medium">
            <CopyField action="Copy address" {...words} />
          </div>
        </div>
        <div class="stack">
          <p class="label">under 20rem</p>
          <div class="width-tiny">
            <CopyField value="192.168.1.20:49400" action="Copy address" {...words} />
          </div>
        </div>
        <div class="stack">
          <p class="label">a long value wraps; it is never cut off</p>
          <div class="width-compact">
            <CopyField
              value="http://192.168.1.20:49400/stream/4f2a9c1e-7b3d-4e8a-9f60-2d51c8a3b7e4/listen.flac"
              action="Copy URL"
              {...words}
            />
          </div>
        </div>
      </div>
      <p class="label">Cast URL (reveal on refusal): rest, then refused</p>
      <div class="width-compact stack">
        <CopyField
          value={URL}
          action="Copy URL"
          reveal="onRefusal"
          help="For a player such as VLC on this computer."
          {...words}
        />
        <Pressed>
          <CopyField
            value={URL}
            action="Copy URL"
            reveal="onRefusal"
            clipboard={fakeClipboard(false)}
            {...words}
          />
        </Pressed>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ AddressField */

const SERVER = {
  label: 'Server address',
  action: { idle: 'Connect', busy: 'Connecting…', failed: 'Try again' },
  placeholder: 'http://localhost:49400',
  validate: (v: string): string | undefined => {
    try {
      const url = new globalThis.URL(v);
      return url.protocol === 'http:' || url.protocol === 'https:'
        ? undefined
        : 'That is not an address Thaumic Cast can use.';
    } catch {
      return 'That is not an address Thaumic Cast can use. Addresses look like http://192.168.1.20:49400.';
    }
  },
};

const answered: AddressResult = {
  ok: true,
  message: 'Thaumic Cast answered',
  detail: '12 ms',
  said: 'Thaumic Cast answered, 12 ms',
};
const nothing: AddressResult = { ok: false, error: 'Nothing answered at that address.' };

/**
 * One server AddressField in a given state.
 * @param props - Component props
 * @param props.initial - The typed value
 * @param props.onTest - The test
 * @param props.press - Press Connect on mount
 * @param props.help - The help line
 * @returns The field
 */
function ServerAddress({
  initial,
  onTest,
  press = false,
  help,
}: {
  initial: string;
  onTest: () => Promise<AddressResult>;
  press?: boolean;
  help?: string;
}): JSX.Element {
  const [value, setValue] = useState(initial);
  const field = (
    <AddressField
      kind="server"
      {...SERVER}
      value={value}
      onChange={setValue}
      onTest={onTest}
      help={help}
    />
  );
  return press ? <Pressed selector="button[type=submit]">{field}</Pressed> : field;
}

/**
 * AddressField: the server kind at idle, testing, success, failed and invalid; compact in
 * the popup and beside on the desktop; the speaker kind with its Chips.
 * @returns The specimen
 */
export function AddressFieldSpecimen(): JSX.Element {
  const [ips, setIps] = useState(['192.168.1.47', '192.168.1.52']);
  const [ip, setIp] = useState('');
  return (
    <div class="stack">
      <div data-density="desktop" class="stack width-medium">
        <p class="label">Options › Companion (beside, from 25rem)</p>
        <ServerAddress
          initial=""
          onTest={() => Promise.resolve(answered)}
          help="Select Connect to use the address; it is saved only if Thaumic Cast answers there."
        />
        <p class="label">testing</p>
        <ServerAddress initial="http://192.168.1.20:49400" onTest={never} press />
        <p class="label">success</p>
        <ServerAddress
          initial="http://192.168.1.20:49400"
          onTest={() => Promise.resolve(answered)}
          press
        />
        <p class="label">failed (no aria-invalid)</p>
        <ServerAddress
          initial="http://192.168.1.21:49400"
          onTest={() => Promise.resolve(nothing)}
          press
        />
        <p class="label">invalid (P-forms)</p>
        <ServerAddress initial="localhost 49400" onTest={() => Promise.resolve(answered)} press />
        <p class="label">disabled</p>
        <AddressField
          kind="server"
          {...SERVER}
          value=""
          onChange={noop}
          onTest={() => Promise.resolve(answered)}
          disabled
        />
      </div>
      <div class="stack width-compact">
        <p class="label">Popup onboarding (compact: the action full width)</p>
        <ServerAddress initial="" onTest={() => Promise.resolve(answered)} />
      </div>
      <div data-density="desktop" class="stack width-medium">
        <p class="label">Desktop Settings › Speakers (speaker kind)</p>
        <AddressField
          kind="speaker"
          label="Add a speaker by IP address"
          placeholder="192.168.1.100"
          action={{ idle: 'Add speaker', busy: 'Knocking politely…', failed: 'Try again' }}
          value={ip}
          onChange={setIp}
          onTest={async (address) => {
            setIps((list) => [...list, address]);
            return { ok: true, said: `${address} is on the list.` };
          }}
          list={ips}
          listLabel="Added by IP address"
          removeLabel={(address) => `Remove ${address}`}
          onRemove={(address) => setIps((list) => list.filter((a) => a !== address))}
        />
      </div>
    </div>
  );
}

/* --------------------------------------------------------- DescriptionList */

/**
 * DescriptionList: readout, stat (counts and a CopyField) and checklist.
 * @returns The specimen
 */
export function DescriptionListSpecimen(): JSX.Element {
  return (
    <div class="stack" data-density="desktop">
      <div class="width-medium">
        <Card title="For the next tab cast" level={3}>
          <DescriptionList
            kind="readout"
            rows={[
              { key: 'codec', term: 'Codec', value: 'PCM' },
              { key: 'bitrate', term: 'Bitrate', value: 'Lossless' },
              { key: 'channels', term: 'Channels', value: 'Stereo' },
              { key: 'delay', term: 'Added delay', value: 'About 450 ms' },
            ]}
          />
        </Card>
      </div>
      <div class="width-medium">
        <Card title="Running" level={3}>
          <DescriptionList
            kind="stat"
            rows={[
              {
                key: 'address',
                term: 'Address',
                value: (
                  <CopyField
                    value="192.168.1.20:49400"
                    action="Copy address"
                    done="Copied"
                    refusedNote="The clipboard said no. Here it is, selected, to copy by hand."
                    unavailableNote="This computer's address isn't known yet."
                  />
                ),
              },
              { key: 'clients', term: 'Extension connections', value: 2, count: true },
              { key: 'streams', term: 'Casts running', value: 1, count: true },
            ]}
          />
        </Card>
      </div>
      <div class="width-compact">
        <Card title="Stacked under 25rem" level={3}>
          <DescriptionList
            kind="readout"
            rows={[
              { key: 'codec', term: 'Codec', value: 'AAC-LC' },
              { key: 'bitrate', term: 'Bitrate', value: '192 kbps' },
            ]}
          />
        </Card>
      </div>
      <DescriptionList
        kind="checklist"
        aria-label="Ready"
        rows={[
          { key: 'app', state: 'connected', text: 'Desktop app: running' },
          { key: 'rooms', state: 'connected', text: 'Rooms: 4 answered' },
          { key: 'ext', state: 'checking', text: 'Extension: not heard from yet' },
          { key: 'none', state: 'failed', text: 'Rooms: none answered' },
        ]}
      />
    </div>
  );
}

/* -------------------------------------------------------------- Disclosure */

/**
 * Disclosure: shut, open, with a summary, every grammar state, disabled, both densities.
 * @returns The specimen
 */
export function DisclosureSpecimen(): JSX.Element {
  const [open, setOpen] = useState(false);
  const panel = <p class="label">Smoothing, frame size and the rest.</p>;
  return (
    <div class="stack narrow">
      <Disclosure label="Advanced" open={open} onOpenChange={setOpen}>
        {panel}
      </Disclosure>
      <Disclosure label="3 rooms" summary="Kitchen 30 · Living Room muted · TV Room 46">
        {panel}
      </Disclosure>
      <Disclosure label="Enter the address yourself" defaultOpen>
        {panel}
      </Disclosure>
      <StateGrid kinds={['Advanced']}>
        <StateRow state="hover">
          <Disclosure label="Advanced" data-force="hover">
            {panel}
          </Disclosure>
        </StateRow>
        <StateRow state="focus-visible">
          <Disclosure label="Advanced" data-force="focus">
            {panel}
          </Disclosure>
        </StateRow>
        <StateRow state="active">
          <Disclosure label="Advanced" data-force="press">
            {panel}
          </Disclosure>
        </StateRow>
        <StateRow state="disabled">
          <Disclosure label="Advanced" disabled>
            {panel}
          </Disclosure>
        </StateRow>
      </StateGrid>
      {(['popup', 'desktop'] as const).map((density) => (
        <div key={density} class="stack" data-density={density}>
          <p class="label">
            {density === 'popup' ? 'Popup: sm and md (2.25rem)' : 'Desktop: sm and md (2.75rem)'}
          </p>
          <Disclosure label={`Advanced (${density})`} summary="Smoothing 200 ms">
            {panel}
          </Disclosure>
          <Disclosure label="3 rooms" size="md" summary="Kitchen 30 · Living Room muted">
            {panel}
          </Disclosure>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- EmptyState */

/**
 * EmptyState: the popup's one sentence, searching, offline, and the desktop's stacked form.
 * @returns The specimen
 */
export function EmptyStateSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <div class="width-compact stack">
        <Card>
          <EmptyState body="No speaker answered. Check they are switched on, and on the same network as the companion." />
        </Card>
        <Card>
          <EmptyState kind="searching" body="Asking for speakers…" />
        </Card>
        <Card>
          <EmptyState
            kind="offline"
            body="Nothing connected. The extension can do very little on its own, and is doing it."
            action={<Button size="sm">Reconnect</Button>}
          />
        </Card>
      </div>
      <div data-density="desktop" class="width-medium">
        <Card>
          <EmptyState
            title="No speaker answered"
            body="The network was asked for Sonos speakers and returned none. Check they are switched on and on this network, then ask again."
            action={<Button icon="refresh">Ask again</Button>}
            link={
              <>
                If asking gets nowhere, a speaker can be{' '}
                <a href="#empty-state">added by its IP address</a>.
              </>
            }
          />
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Notice */

/**
 * Notice: the banner and section kinds in each tone, with and without a lead, an action,
 * Details, X and also; popup and desktop densities.
 * @returns The specimen
 */
export function NoticeSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <div class="width-compact stack">
        <Notice
          kind="banner"
          tone="danger"
          lead="No desktop app or server answered"
          text="Thaumic Cast needs the desktop app or a server running to reach the speakers; start one, then try again."
          action={{ label: 'Try again', onClick: noop }}
        />
        <Notice
          kind="banner"
          tone="danger"
          lead="Connection lost, casts stopped"
          text="Check it is running, then select Reconnect."
          action={{ label: 'Reconnect', onClick: noop }}
          also="No speaker can be reached"
        />
        <Notice
          kind="banner"
          tone="warning"
          lead="This companion is older than the extension"
          text="It is on v0.10.2, and it may still work. If anything misbehaves, update it."
          action={{ label: 'Update desktop app', onClick: noop }}
          onDismiss={noop}
        />
        <Notice
          tone="warning"
          lead="Kitchen cut out"
          text="Raise the speaker head start to 1200 ms."
          details={{
            label: 'Details',
            content: 'Its reserve ran dry three times in the last minute.',
          }}
          onDismiss={noop}
        />
        <Notice
          tone="warning"
          text="A laptop on battery may throttle the tab, and the audio with it."
        />
        <Notice tone="info" text="Browser-wide capture casts PCM, whatever Quality is chosen." />
        <p class="label">the action busy, then failed</p>
        <Pressed>
          <Notice
            tone="danger"
            lead="Kitchen did not join"
            action={{ label: 'Try again', onAction: never, labels: { busy: 'Trying…' } }}
          />
        </Pressed>
        <Pressed>
          <Notice
            tone="danger"
            lead="Kitchen did not join"
            action={{
              label: 'Ask again',
              onAction: () => Promise.reject(new Error('no')),
              labels: { failed: 'Try again' },
            }}
          />
        </Pressed>
      </div>
      <div data-density="desktop" class="width-medium stack">
        <Notice
          tone="warning"
          lead="No reply from the speakers"
          text="They were found, and then went quiet. Check the network lets them answer."
          action={{ label: 'Open settings', onClick: noop }}
          onDismiss={noop}
        />
        <Notice tone="danger" text="The speaker could not be added." onDismiss={noop} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- NoticeLine */

/**
 * NoticeLine: the five uses.
 * @returns The specimen
 */
export function NoticeLineSpecimen(): JSX.Element {
  return (
    <div class="stack width-compact">
      <p class="label">row line</p>
      <NoticeLine
        tone="danger"
        lead="Bedroom did not join"
        action={{ label: 'Try again', onClick: noop }}
        onDismiss={noop}
      />
      <p class="label">tile note, details open</p>
      <NoticeLine
        tone="info"
        lead="Patio left this cast"
        details={{
          label: 'Details',
          open: true,
          content: 'Patio started playing something else, and it only plays one thing at a time.',
        }}
        onDismiss={noop}
      />
      <p class="label">CastBar line</p>
      <NoticeLine
        tone="danger"
        lead="The cast did not start"
        text="Trying again costs nothing and sometimes works."
        onDismiss={noop}
      />
      <p class="label">slot line</p>
      <NoticeLine
        tone="warning"
        lead="Kitchen may cut out soon"
        opensTile={{ onOpen: noop, label: 'Kitchen may cut out soon: open this cast' }}
      />
      <p class="label">row line: the action busy, then failed</p>
      <Pressed>
        <NoticeLine
          tone="danger"
          lead="Bedroom did not join"
          action={{ label: 'Try again', onAction: never, labels: { busy: 'Trying…' } }}
          onDismiss={noop}
        />
      </Pressed>
      <Pressed>
        <NoticeLine
          tone="danger"
          lead="Bedroom did not join"
          action={{
            label: 'Ask again',
            onAction: () => Promise.reject(new Error('no')),
            labels: { failed: 'Try again' },
          }}
          onDismiss={noop}
        />
      </Pressed>
      <p class="label">away line</p>
      <NoticeLine
        tone="info"
        glyph="history"
        lead="Cast to Bedroom ended"
        srPrefix="While you were away:"
        details={{ label: '2 more', content: 'Cast to Kitchen ended. Patio left this cast.' }}
        onDismiss={noop}
      />
      <p class="label">
        At the popup's own width: a short lead keeps to one row; a longer one wraps, whole
      </p>
      <div class="popup-column stack" data-density="popup" data-popup-lines="">
        <NoticeLine
          tone="danger"
          lead="Bedroom did not join"
          action={{ label: 'Try again', onClick: noop }}
          onDismiss={noop}
          announce={false}
        />
        <NoticeLine
          tone="info"
          glyph="history"
          lead="Patio left"
          srPrefix="While you were away:"
          details={{ label: '2 more', content: 'Cast to Kitchen ended.' }}
          onDismiss={noop}
          announce={false}
        />
        <NoticeLine
          tone="info"
          glyph="history"
          lead="Cast to Bedroom ended"
          srPrefix="While you were away:"
          details={{ label: '2 more', content: 'Cast to Kitchen ended.' }}
          onDismiss={noop}
          announce={false}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- Toast */

/**
 * A toast that goes on Esc or X, and a Button that brings it back without taking focus
 * from it.
 * @returns The specimen
 */
function DismissibleToast(): JSX.Element {
  const [shown, setShown] = useState(true);
  return (
    <div class="stack">
      <Button kind="quiet" onClick={() => setShown(true)}>
        Show the toast again
      </Button>
      {shown && (
        <Toast
          text="Garden left this cast"
          action={{ label: 'Undo', onClick: noop }}
          onDismiss={() => setShown(false)}
        />
      )}
    </div>
  );
}

/**
 * Toast: with Undo, and without an action; a long message wraps; Undo busy and failed; one
 * that Esc and X really dismiss.
 * @returns The specimen
 */
export function ToastSpecimen(): JSX.Element {
  return (
    <div class="stack width-compact">
      <p class="label">Esc or X dismisses it (an Esc that hides a tooltip does not)</p>
      <DismissibleToast />
      <Toast
        text="Kitchen left this cast"
        action={{ label: 'Undo', onClick: noop }}
        onDismiss={noop}
      />
      <Toast
        text="Cast to Bedroom ended. The cast was stopped at the companion's end."
        onDismiss={noop}
      />
      <div data-density="desktop">
        <Toast
          text="Evenings removed."
          action={{ label: 'Undo', onClick: noop }}
          onDismiss={noop}
        />
      </div>
      <p class="label">Undo busy, then failed</p>
      <Pressed>
        <Toast
          text="Kitchen left this cast"
          action={{ label: 'Undo', onAction: never, labels: { busy: 'Undoing…' } }}
          onDismiss={noop}
        />
      </Pressed>
      <Pressed>
        <Toast
          text="Kitchen left this cast"
          action={{
            label: 'Undo',
            onAction: () => Promise.reject(new Error('no')),
            labels: { failed: 'Try again' },
          }}
          onDismiss={noop}
        />
      </Pressed>
    </div>
  );
}

/* -------------------------------------------------------------- WizardStep */

/**
 * WizardStep: compact (popup) and full (desktop).
 * @returns The specimen
 */
export function WizardStepSpecimen(): JSX.Element {
  const id = useId();
  return (
    <div class="stack">
      <div class="width-compact">
        <Card>
          <WizardStep
            title="The companion"
            subtitle="The half that talks to the speakers"
            glyph="monitor"
            titleId={`${id}-1`}
            subtitleId={`${id}-1d`}
          >
            <p class="label">The step's body.</p>
          </WizardStep>
        </Card>
      </div>
      <div data-density="desktop">
        <WizardStep
          title="The speakers"
          subtitle="Finding out who is in"
          glyph="speaker"
          titleId={`${id}-2`}
          subtitleId={`${id}-2d`}
        >
          <p class="label">The step's body.</p>
        </WizardStep>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- PageHeader */

/**
 * PageHeader: a view with its summary and actions, and the options page's plain title.
 * @returns The specimen
 */
export function PageHeaderSpecimen(): JSX.Element {
  return (
    <div class="stack" data-density="desktop">
      <PageHeader
        title="Speakers"
        summary="4 rooms, 2 casting"
        actions={
          <Cluster>
            <Button icon="refresh">Ask again</Button>
            <Button kind="filled" danger icon="stop">
              Stop all casts
            </Button>
          </Cluster>
        }
      />
      <PageHeader title="Settings" />
    </div>
  );
}

/* -------------------------------------------------------------------- Card */

/**
 * Card: titled (a named section), with meta and actions, plain, flush; both densities.
 * @returns The specimen
 */
export function CardSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <div data-density="desktop" class="stack width-medium">
        <Card title="Appearance" level={3}>
          <p class="label">A titled card is a section named by its SectionHeader.</p>
        </Card>
        <Card
          title="Speakers"
          level={3}
          meta="2 casting"
          actions={
            <Button size="sm" kind="quiet" icon="refresh">
              Ask again
            </Button>
          }
        >
          <p class="label">Meta and actions sit in the header.</p>
        </Card>
      </div>
      <div class="stack width-compact">
        <Card aria-label="Plain card">
          <p class="label">Popup density: 12 px padding.</p>
        </Card>
        <Card flush aria-label="Flush card">
          <p class="label flush-demo">Flush: the content lays out its own edge (here, padding).</p>
        </Card>
      </div>
    </div>
  );
}
