import type { ComponentChildren, JSX } from 'preact';
import { useId, useState } from 'preact/hooks';
import { Artwork } from '../../src/Artwork';
import { Badge, type BadgeTone } from '../../src/Badge';
import { BrandBlock } from '../../src/BrandBlock';
import { Button, type ButtonProps } from '../../src/Button';
import { Checkbox } from '../../src/Checkbox';
import { Chip } from '../../src/Chip';
import { Clacks } from '../../src/Clacks';
import { Cluster } from '../../src/Cluster';
import { Divider } from '../../src/Divider';
import { IconButton, type IconButtonProps } from '../../src/IconButton';
import { Meter } from '../../src/Meter';
import { NavItem } from '../../src/NavItem';
import { Radio } from '../../src/Radio';
import { SectionHeader } from '../../src/SectionHeader';
import { SegmentedControl } from '../../src/SegmentedControl';
import { Select } from '../../src/Select';
import { Slider } from '../../src/Slider';
import { StatusDot } from '../../src/StatusDot';
import { StepIndicator } from '../../src/StepIndicator';
import { Switch } from '../../src/Switch';
import { TextInput } from '../../src/TextInput';
import { Tooltip } from '../../src/Tooltip';

/**
 * The F-grammar states a specimen can force without a pointer. `data-force` draws hover,
 * focus-visible and press (DESIGN.md §3); the rest are real props.
 */
type Forced = 'hover' | 'focus' | 'press';

/**
 * A grid of states: one row per state, one column per kind.
 * @param props - Component props
 * @param props.kinds - The column headings
 * @param props.children - The rows (StateRow)
 * @returns The grid
 */
export function StateGrid({
  kinds,
  children,
}: {
  kinds: string[];
  children: ComponentChildren;
}): JSX.Element {
  return (
    <div class="state-grid" style={{ '--cols': kinds.length }}>
      <span />
      {kinds.map((k) => (
        <span key={k} class="label">
          {k}
        </span>
      ))}
      {children}
    </div>
  );
}

/**
 * One row of a StateGrid.
 * @param props - Component props
 * @param props.state - The state's name
 * @param props.children - One cell per kind
 * @returns The row's cells
 */
export function StateRow({
  state,
  children,
}: {
  state: string;
  children: ComponentChildren;
}): JSX.Element {
  return (
    <>
      <span class="label">{state}</span>
      {children}
    </>
  );
}

const noop = (): void => {};
const never = (): Promise<void> => new Promise(() => {});

/* ------------------------------------------------------------------ Button */

const BUTTON_KINDS: { title: string; props: Partial<ButtonProps>; label: string }[] = [
  { title: 'filled', props: { kind: 'filled', icon: 'cast' }, label: 'Cast' },
  {
    title: 'filled danger',
    props: { kind: 'filled', danger: true, icon: 'stop' },
    label: 'Stop all casts',
  },
  { title: 'tonal', props: { kind: 'tonal' }, label: 'Connect' },
  { title: 'tonal danger', props: { kind: 'tonal', danger: true, icon: 'stop' }, label: 'Stop' },
  { title: 'outline', props: { kind: 'outline' }, label: 'Cancel' },
  { title: 'quiet', props: { kind: 'quiet', icon: 'plus' }, label: 'Add a room' },
  {
    title: 'link',
    props: { kind: 'link', icon: 'external', href: '#button' },
    label: 'Update available',
  },
];

const FORCED: Forced[] = ['hover', 'focus', 'press'];

/**
 * A Button that shows one async result at once: it runs its action on mount.
 * @param props - Component props
 * @param props.result - The result to show
 * @param props.base - The kind's props
 * @param props.label - The idle label
 * @returns The Button
 */
function ResultButton({
  result,
  base,
  label,
}: {
  result: 'busy' | 'done' | 'failed';
  base: Partial<ButtonProps>;
  label: string;
}): JSX.Element {
  const [started, setStarted] = useState(false);
  const action =
    result === 'busy'
      ? never
      : result === 'done'
        ? () => Promise.resolve()
        : () => Promise.reject();
  return (
    <span
      ref={(el) => {
        if (el && !started) {
          setStarted(true);
          requestAnimationFrame(() => el.querySelector('button')?.click());
        }
      }}
    >
      <Button
        {...base}
        size="sm"
        onAction={action}
        labels={{ busy: 'Working…', done: 'Connected', failed: 'Try again' }}
      >
        {label}
      </Button>
    </span>
  );
}

/**
 * A Button that runs its whole cycle on a press: busy for a moment, then done (or failed,
 * every other press for `fails`), then back to idle, so the change of state can be watched both
 * ways and its box measured.
 * @param props - Component props
 * @param props.base - The kind's props
 * @param props.label - The idle label
 * @param props.fails - Fail every other run
 * @returns The Button
 */
function CycleButton({
  base,
  label,
  fails = false,
}: {
  base: Partial<ButtonProps>;
  label: string;
  fails?: boolean;
}): JSX.Element {
  const [reset, setReset] = useState(0);
  const [runs, setRuns] = useState(0);
  const action = (): Promise<void> => {
    const fail = fails && runs % 2 === 1;
    setRuns((n) => n + 1);
    return new Promise<void>((resolve, reject) =>
      setTimeout(() => {
        // Back to idle a moment after the result shows.
        setTimeout(() => setReset((n) => n + 1), 1600);
        if (fail) reject(new Error('demo'));
        else resolve();
      }, 900),
    );
  };
  return (
    <Button
      {...base}
      size="sm"
      onAction={action}
      resetKey={reset}
      labels={{ busy: 'Working…', done: 'Done', failed: 'Try again' }}
      data-cycle=""
    >
      {label}
    </Button>
  );
}

/**
 * A set Button that turns on and off: its check slot is always there, so it never resizes.
 * @returns The Button
 */
function ToggleSetButton(): JSX.Element {
  const [on, setOn] = useState(false);
  return (
    <Button
      kind="quiet"
      icon="history"
      pressed={on}
      trail="3"
      onClick={() => setOn((v) => !v)}
      data-toggle=""
    >
      Last cast
    </Button>
  );
}

/**
 * Button: every kind in every state, popup and desktop sizes.
 * @returns The specimen
 */
export function ButtonSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <StateGrid kinds={BUTTON_KINDS.map((k) => k.title)}>
        <StateRow state="rest">
          {BUTTON_KINDS.map(({ title, props, label }) => (
            <Button key={title} {...props} size="sm" onClick={noop}>
              {label}
            </Button>
          ))}
        </StateRow>
        {FORCED.map((f) => (
          <StateRow key={f} state={f === 'focus' ? 'focus-visible' : f === 'press' ? 'active' : f}>
            {BUTTON_KINDS.map(({ title, props, label }) => (
              <Button key={title} {...props} size="sm" data-force={f}>
                {label}
              </Button>
            ))}
          </StateRow>
        ))}
        <StateRow state="pressed (on)">
          {BUTTON_KINDS.map(({ title }) =>
            title === 'quiet' ? (
              <Button key={title} kind="quiet" icon="history" pressed size="sm" trail="3">
                Last cast
              </Button>
            ) : (
              <span key={title} class="token-value">
                n/a
              </span>
            ),
          )}
        </StateRow>
        <StateRow state="disabled">
          {BUTTON_KINDS.map(({ title, props, label }) => (
            <Button key={title} {...props} size="sm" disabled>
              {label}
            </Button>
          ))}
        </StateRow>
        <StateRow state="busy">
          {BUTTON_KINDS.map(({ title, props, label }) =>
            props.kind === 'outline' || props.kind === 'quiet' || props.kind === 'link' ? (
              <span key={title} class="token-value">
                n/a
              </span>
            ) : (
              <ResultButton key={title} result="busy" base={props} label={label} />
            ),
          )}
        </StateRow>
        <StateRow state="done">
          {BUTTON_KINDS.map(({ title, props, label }) =>
            title === 'tonal' ? (
              <ResultButton key={title} result="done" base={props} label={label} />
            ) : (
              <span key={title} class="token-value">
                n/a
              </span>
            ),
          )}
        </StateRow>
        <StateRow state="failed">
          {BUTTON_KINDS.map(({ title, props, label }) =>
            title === 'tonal' || title === 'filled' ? (
              <ResultButton key={title} result="failed" base={props} label={label} />
            ) : (
              <span key={title} class="token-value">
                n/a
              </span>
            ),
          )}
        </StateRow>
      </StateGrid>
      <p class="label">
        Press one: busy, then done (failed on every other press of the last two), then back to idle.
        Each state is one unit in one cell, so nothing changes size.
      </p>
      <Cluster>
        {BUTTON_KINDS.filter((k) => k.props.kind !== 'link').map(({ title, props, label }) => (
          <CycleButton key={title} base={props} label={label} />
        ))}
        <CycleButton base={{ kind: 'tonal' }} label="Connect" fails />
        <CycleButton base={{ kind: 'filled', icon: 'cast' }} label="Cast" fails />
        <ToggleSetButton />
      </Cluster>
      <p class="label">Disclosure trigger, description and full width</p>
      <Cluster>
        <Button kind="quiet" icon="plus" expanded={false} size="sm">
          Add a room
        </Button>
        <Button kind="quiet" icon="plus" expanded size="sm">
          Add a room
        </Button>
      </Cluster>
      <div class="narrow stack">
        <Button
          kind="quiet"
          pressed={false}
          align="start"
          fullWidth
          description="Garden is not answering; Study goes alone."
        >
          Garden and Study
        </Button>
        <Button kind="filled" icon="cast" fullWidth>
          Cast to 3 rooms
        </Button>
      </div>
      {(['popup', 'desktop'] as const).map((density) => (
        <div key={density} class="stack" data-density={density}>
          <p class="label">
            {density === 'popup'
              ? 'Sizes, popup: sm 2rem (the default) and md 2.25rem'
              : 'Sizes, desktop: sm 2rem (the default) and md 2.75rem'}
          </p>
          <Cluster>
            <Button icon="refresh" size="sm">
              Ask again
            </Button>
            <Button icon="refresh" size="md">
              Ask again
            </Button>
            <Button kind="filled" icon="cast" size="md">
              Cast to 3 rooms
            </Button>
            <Button kind="filled" danger icon="stop" size="md">
              Stop all casts
            </Button>
          </Cluster>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- IconButton */

const ICON_KINDS: { title: string; props: IconButtonProps }[] = [
  { title: 'Settings', props: { glyph: 'settings', label: 'Settings', kind: 'tonal' } },
  { title: 'Play', props: { glyph: 'play', label: 'Play', kind: 'tonal' } },
  { title: 'Previous', props: { glyph: 'prev', label: 'Previous track' } },
  {
    title: 'Mute',
    props: { glyph: 'volume', pressedGlyph: 'volume-off', label: 'Mute Kitchen' },
  },
  { title: 'Remove', props: { glyph: 'stop', label: 'Remove Kitchen' } },
  { title: 'Dismiss sm', props: { glyph: 'x', label: 'Dismiss', size: 'sm' } },
  { title: 'Back', props: { glyph: 'chevron-start', label: 'Back' } },
];

/**
 * IconButton: quiet and tonal, every state, both densities, the desktop Tooltip.
 * @returns The specimen
 */
export function IconButtonSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <StateGrid kinds={ICON_KINDS.map((k) => k.title)}>
        <StateRow state="rest">
          {ICON_KINDS.map(({ title, props }) => (
            <IconButton key={title} {...props} />
          ))}
        </StateRow>
        {FORCED.map((f) => (
          <StateRow key={f} state={f === 'focus' ? 'focus-visible' : f === 'press' ? 'active' : f}>
            {ICON_KINDS.map(({ title, props }) => (
              <IconButton key={title} {...props} data-force={f} />
            ))}
          </StateRow>
        ))}
        <StateRow state="pressed">
          {ICON_KINDS.map(({ title, props }) =>
            props.pressedGlyph ? (
              <IconButton key={title} {...props} pressed />
            ) : (
              <span key={title} class="token-value">
                n/a
              </span>
            ),
          )}
        </StateRow>
        <StateRow state="disabled">
          {ICON_KINDS.map(({ title, props }) => (
            <IconButton key={title} {...props} disabled />
          ))}
        </StateRow>
        <StateRow state="busy">
          {ICON_KINDS.map(({ title, props }) => (
            <IconButton key={title} {...props} busy />
          ))}
        </StateRow>
      </StateGrid>
      <p class="label">
        Desktop density: the same sm 1.75rem and md 2rem boxes, hit areas to 2.75rem, with the
        Tooltip
      </p>
      <div data-density="desktop">
        <Cluster>
          <IconButton glyph="settings" label="Settings" kind="tonal" tooltip />
          <IconButton glyph="x" label="Close" size="sm" tooltip />
          <IconButton glyph="volume" pressedGlyph="volume-off" label="Mute Kitchen" tooltip />
          <IconButton glyph="copy" label="Copy URL" tooltip />
        </Cluster>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- TextInput */

/**
 * TextInput: text, address and search in every state.
 * @returns The specimen
 */
export function TextInputSpecimen(): JSX.Element {
  const [search, setSearch] = useState('kit');
  const cells = (props: Partial<Parameters<typeof TextInput>[0]>, value: string): JSX.Element[] => [
    <TextInput
      key="t"
      aria-label="Set name"
      value={value && 'Kitchen + Patio'}
      onInput={noop}
      placeholder="Name this set"
      {...props}
    />,
    <TextInput
      key="a"
      kind="address"
      aria-label="Server address"
      value={value && 'http://192.168.1.20:49400'}
      onInput={noop}
      placeholder="http://localhost:49400"
      {...props}
    />,
  ];
  return (
    <div class="stack">
      <StateGrid kinds={['text', 'address']}>
        <StateRow state="rest (empty)">{cells({}, '')}</StateRow>
        <StateRow state="hover">{cells({ 'data-force': 'hover' }, 'x')}</StateRow>
        <StateRow state="focus-visible">{cells({ 'data-force': 'focus' }, 'x')}</StateRow>
        <StateRow state="filled">{cells({}, 'x')}</StateRow>
        <StateRow state="read-only">{cells({ readOnly: true }, 'x')}</StateRow>
        <StateRow state="disabled">{cells({ disabled: true }, 'x')}</StateRow>
        <StateRow state="invalid">{cells({ invalid: true }, 'x')}</StateRow>
      </StateGrid>
      <p class="label">Search (the label is visually hidden; Esc clears)</p>
      <div class="narrow stack">
        <TextInput
          kind="search"
          label="Find a room"
          clearLabel="Clear search"
          placeholder="Find a room"
          value={search}
          onInput={setSearch}
        />
        <TextInput
          kind="search"
          label="Find a room"
          clearLabel="Clear search"
          placeholder="Find a room"
          value=""
          onInput={noop}
          disabled
        />
      </div>
      <StateGrid kinds={['search']}>
        <StateRow state="hover">
          <TextInput
            kind="search"
            label="Find a room, hover"
            placeholder="Find a room"
            value=""
            onInput={noop}
            data-force="hover"
          />
        </StateRow>
        <StateRow state="focus-visible">
          <TextInput
            kind="search"
            label="Find a room, focus"
            placeholder="Find a room"
            value="kit"
            clearLabel="Clear search"
            onInput={noop}
            data-force="focus"
          />
        </StateRow>
        <StateRow state="invalid">
          <TextInput
            kind="search"
            label="Find a room, invalid"
            placeholder="Find a room"
            value="kit"
            clearLabel="Clear search"
            onInput={noop}
            invalid
          />
        </StateRow>
      </StateGrid>
      {(['popup', 'desktop'] as const).map((density) => (
        <div key={density} class="stack narrow" data-density={density}>
          <p class="label">
            {density === 'popup' ? 'Popup: sm and md (2.25rem)' : 'Desktop: sm and md (2.75rem)'}
          </p>
          <TextInput
            kind="address"
            aria-label={`Speaker address, ${density}, sm`}
            value="192.168.1.47"
            onInput={noop}
            inputMode="decimal"
          />
          <TextInput
            kind="address"
            size="md"
            aria-label={`Server address, ${density}, md`}
            value="http://192.168.1.20:49400"
            onInput={noop}
            inputMode="url"
          />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Switch */

/**
 * Switch: off and on in every state, busy and error, both densities.
 * @returns The specimen
 */
export function SwitchSpecimen(): JSX.Element {
  const [on, setOn] = useState(true);
  return (
    <div class="stack narrow">
      <Switch
        label="Sync video"
        description="Holds the picture back until the speakers catch up."
        checked={on}
        onChange={setOn}
      />
      <StateGrid kinds={['off', 'on']}>
        {(['rest', ...FORCED] as const).map((f) => (
          <StateRow key={f} state={f === 'focus' ? 'focus-visible' : f === 'press' ? 'active' : f}>
            {[false, true].map((c) => (
              <Switch
                key={String(c)}
                label={c ? 'On' : 'Off'}
                checked={c}
                onChange={noop}
                data-force={f === 'rest' ? undefined : f}
              />
            ))}
          </StateRow>
        ))}
        <StateRow state="disabled">
          <Switch label="Off" checked={false} onChange={noop} disabled />
          <Switch label="On" checked onChange={noop} disabled />
        </StateRow>
        <StateRow state="busy">
          <Switch label="Off" checked={false} onChange={noop} busy />
          <Switch label="On" checked onChange={noop} busy />
        </StateRow>
      </StateGrid>
      <Switch
        label="Launch at login"
        checked={false}
        onChange={noop}
        error="The settings were not saved. Try again."
      />
      <Switch
        label="Clock drift correction"
        description="Keeps each speaker's reserve level over a long cast."
        note="Needs speaker monitoring, which is how it knows what to correct."
        checked={false}
        onChange={noop}
        disabled
      />
      <Switch
        label="Sync video"
        badge={<Badge tone="neutral" label="In step" />}
        description="With a Badge after the name; its words are part of the name."
        checked
        onChange={noop}
      />
      <div data-density="desktop">
        <Switch
          label="Speaker monitoring"
          description="Desktop density: 3 × 1.75rem."
          checked
          onChange={noop}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------- Checkbox and Radio */

/**
 * Checkbox: off and on in every state.
 * @returns The specimen
 */
export function CheckboxSpecimen(): JSX.Element {
  const [ticked, setTicked] = useState(true);
  return (
    <div class="stack">
      <StateGrid kinds={['off', 'on']}>
        {(['rest', ...FORCED] as const).map((f) => (
          <StateRow key={f} state={f === 'focus' ? 'focus-visible' : f === 'press' ? 'active' : f}>
            {[false, true].map((c) => (
              <Checkbox
                key={String(c)}
                label="Kitchen"
                checked={c}
                onChange={noop}
                data-force={f === 'rest' ? undefined : f}
              />
            ))}
          </StateRow>
        ))}
        <StateRow state="disabled">
          <Checkbox label="Kitchen" checked={false} onChange={noop} disabled />
          <Checkbox label="Kitchen" checked onChange={noop} disabled />
        </StateRow>
      </StateGrid>
      <p class="label">Inside a disabled fieldset (the picker, not connected)</p>
      <fieldset class="plain-fieldset narrow stack" disabled>
        <legend class="visually-hidden">Cast to (not connected)</legend>
        <Checkbox label="Kitchen" checked onChange={noop} />
        <Checkbox label="Study" checked={false} onChange={noop} />
        <Switch label="Start no louder than" checked onChange={noop} />
        <TextInput
          kind="search"
          label="Find a room"
          placeholder="Find a room"
          value=""
          onInput={noop}
        />
        <Select label="Codec" hideLabel value="aac" options={CODECS} onChange={noop} />
        <Slider label="Kitchen volume" value={30} onChange={noop} readout={3} />
        <Button kind="filled" icon="cast">
          Cast to 1 room
        </Button>
      </fieldset>
      <div data-density="desktop" class="narrow">
        <Checkbox
          label="Living Room"
          description="Desktop density: a 1.25rem box."
          checked={ticked}
          onChange={setTicked}
        />
      </div>
    </div>
  );
}

/**
 * Radio: the ChoiceGroup option in every state.
 * @returns The specimen
 */
export function RadioSpecimen(): JSX.Element {
  const [value, setValue] = useState('sensible');
  const name = useId();
  return (
    <div class="stack">
      <fieldset class="plain-fieldset narrow">
        <legend class="label">Quality</legend>
        {[
          ['economical', 'Economical', 'The least network.'],
          ['sensible', 'Sensible', 'Neither extravagant nor mean.'],
          ['luxurious', 'Luxurious', 'Every bit, whether or not anyone can hear it.'],
        ].map(([v, l, d]) => (
          <Radio
            key={v}
            name={name}
            value={v}
            label={l}
            description={d}
            checked={value === v}
            onChange={setValue}
          />
        ))}
      </fieldset>
      <StateGrid kinds={['off', 'on']}>
        {(['rest', ...FORCED] as const).map((f) => (
          <StateRow key={f} state={f === 'focus' ? 'focus-visible' : f === 'press' ? 'active' : f}>
            {[false, true].map((c) => (
              <Radio
                key={String(c)}
                name={`${name}-${f}`}
                value={String(c)}
                label="Sensible"
                checked={c}
                onChange={noop}
                data-force={f === 'rest' ? undefined : f}
              />
            ))}
          </StateRow>
        ))}
        <StateRow state="disabled">
          <Radio
            name={`${name}-d`}
            value="a"
            label="Sensible"
            checked={false}
            onChange={noop}
            disabled
          />
          <Radio
            name={`${name}-d`}
            value="b"
            label="Sensible"
            checked
            onChange={noop}
            disabled
            note="Browser-wide capture decides this."
          />
        </StateRow>
      </StateGrid>
    </div>
  );
}

/* ------------------------------------------------------- SegmentedControl */

const THEME_OPTIONS = [
  { value: 'auto', label: 'Auto', glyph: 'contrast' },
  { value: 'light', label: 'Light', glyph: 'sun' },
  { value: 'dark', label: 'Dark', glyph: 'moon' },
] as const;

/**
 * SegmentedControl: Appearance, every segment state, disabled, desktop density.
 * @returns The specimen
 */
export function SegmentedSpecimen(): JSX.Element {
  const [theme, setTheme] = useState<'auto' | 'light' | 'dark'>('auto');
  return (
    <div class="stack">
      <SegmentedControl label="Theme" value={theme} onChange={setTheme} options={THEME_OPTIONS} />
      <Cluster gap="4">
        {FORCED.map((f) => (
          <div key={f} class="stack">
            <span class="label">{f}</span>
            <SegmentedControl
              label={`Theme, ${f}`}
              hideLabel
              value="auto"
              onChange={noop}
              options={THEME_OPTIONS}
              data-force={f}
            />
          </div>
        ))}
      </Cluster>
      <SegmentedControl
        label="Theme (disabled)"
        value="light"
        onChange={noop}
        options={THEME_OPTIONS}
        disabled
      />
      <div data-density="desktop">
        <SegmentedControl
          label="Theme (desktop)"
          value="dark"
          onChange={noop}
          options={THEME_OPTIONS}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Select */

const CODECS = [
  { value: 'aac', label: 'AAC-LC', description: 'Small and widely understood.' },
  { value: 'flac', label: 'FLAC', description: 'Lossless, and larger for it.' },
  { value: 'pcm', label: 'PCM', description: 'Uncompressed; the most network.' },
];

/**
 * Select: the trigger in every state; the listbox where the browser draws one.
 * @returns The specimen
 */
export function SelectSpecimen(): JSX.Element {
  const [codec, setCodec] = useState('aac');
  return (
    <div class="stack narrow">
      <Select label="Codec" value={codec} options={CODECS} onChange={setCodec} />
      <StateGrid kinds={['trigger']}>
        {FORCED.map((f) => (
          <StateRow key={f} state={f === 'focus' ? 'focus-visible' : f === 'press' ? 'active' : f}>
            <Select
              label={`Codec, ${f}`}
              hideLabel
              value="aac"
              options={CODECS}
              onChange={noop}
              data-force={f}
            />
          </StateRow>
        ))}
        <StateRow state="open">
          <Select
            label="Codec, open"
            hideLabel
            value="aac"
            options={CODECS}
            onChange={noop}
            data-force="open"
          />
        </StateRow>
        <StateRow state="disabled">
          <Select
            label="Codec, disabled"
            hideLabel
            value="aac"
            options={CODECS}
            onChange={noop}
            disabled
          />
        </StateRow>
        <StateRow state="busy">
          <Select
            label="Language, busy"
            hideLabel
            value="aac"
            options={CODECS}
            onChange={noop}
            busy
          />
        </StateRow>
        <StateRow state="error">
          <Select
            label="Codec, error"
            hideLabel
            value="aac"
            options={CODECS}
            onChange={noop}
            error
          />
        </StateRow>
      </StateGrid>
      {(['popup', 'desktop'] as const).map((density) => (
        <div key={density} class="stack" data-density={density}>
          <p class="label">
            {density === 'popup' ? 'Popup: sm and md (2.25rem)' : 'Desktop: sm and md (2.75rem)'}
          </p>
          <Select
            label={`Head start (${density}, sm)`}
            value={250}
            options={[
              { value: 0, label: 'Off' },
              { value: 250, label: '250 ms' },
            ]}
            onChange={noop}
          />
          <Select
            label={`Codec (${density}, md)`}
            size="md"
            value="aac"
            options={CODECS}
            onChange={noop}
          />
        </div>
      ))}
      <p class="label">
        The open list is the browser's own popover: press a Select above to see it (a styled listbox
        in Chromium, the system list in WebKit).
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ Slider */

/**
 * Slider: volume, trim with a centre, the unknown level, every state.
 * @returns The specimen
 */
export function SliderSpecimen(): JSX.Element {
  const [volume, setVolume] = useState(30);
  const [trim, setTrim] = useState(120);
  const [start, setStart] = useState(30);
  const ms = (v: number): string => `${v > 0 ? '+' : ''}${v} ms`;
  return (
    <div class="stack narrow">
      <Slider label="Kitchen volume" value={volume} onChange={setVolume} readout={3} />
      <Slider
        label="Fine-tune"
        min={-500}
        max={500}
        step={10}
        centre={0}
        value={trim}
        onChange={setTrim}
        format={ms}
        readout={7}
      />
      <span class="label">a ghost tick at the room's level now (72), the start level at 30</span>
      <Slider label="Kitchen start level" value={start} onChange={setStart} mark={72} readout={3} />
      {FORCED.map((f) => (
        <div key={f}>
          <span class="label">{f}</span>
          <Slider label={`Volume, ${f}`} value={46} onChange={noop} data-force={f} readout={3} />
        </div>
      ))}
      <span class="label">disabled (joining)</span>
      <Slider label="Bedroom volume" value={30} onChange={noop} disabled readout={3} />
      <span class="label">not known yet</span>
      <Slider
        label="Study volume"
        value={undefined}
        unknownText="Not known yet"
        onChange={noop}
        readout={3}
      />
    </div>
  );
}

/* ------------------------------------------------- Badge, StatusDot, Clacks */

const BADGES: [BadgeTone, string[]][] = [
  ['casting', ['Casting']],
  ['neutral', ['Not playing', 'Paused', 'Casting from elsewhere', 'In step']],
  ['warning', ['In use', 'Out of step', 'No answer']],
  ['danger', ['Still playing', 'Did not join']],
  ['busy', ['Joining…', 'Measuring…']],
];

/**
 * Badge: every tone, on the ground, a card and a container.
 * @returns The specimen
 */
export function BadgeSpecimen(): JSX.Element {
  const set = (
    <div class="stack">
      {BADGES.map(([tone, words]) => (
        <Cluster key={tone} gap="2">
          <span class="label badge-tone">{tone}</span>
          {words.map((w) => (
            <Badge key={w} tone={tone} label={w} />
          ))}
        </Cluster>
      ))}
    </div>
  );
  return (
    <div class="stack">
      {set}
      <div class="on-card">{set}</div>
      <div class="on-container">{set}</div>
    </div>
  );
}

/**
 * StatusDot: the four states at both sizes, always beside words.
 * @returns The specimen
 */
export function StatusDotSpecimen(): JSX.Element {
  const lines = (size: 'sm' | 'md'): JSX.Element => (
    <ul class={`plain-list dot-lines ${size}`}>
      <li>
        <StatusDot state="connected" size={size} /> Connected to the desktop app
      </li>
      <li>
        <StatusDot state="checking" size={size} /> Looking for a companion…
      </li>
      <li>
        <StatusDot state="failed" size={size} /> Not connected
      </li>
      <li>
        <StatusDot state="live" size={size} /> <strong>Video title</strong>
      </li>
    </ul>
  );
  return (
    <div class="stack">
      <Cluster gap="4">
        {lines('sm')}
        <div class="on-card">{lines('md')}</div>
      </Cluster>
      <div class="fill-demo">
        <StatusDot state="live" size="md" onFill /> Casting
      </div>
    </div>
  );
}

/**
 * Clacks: working and answered, both sizes, with words.
 * @returns The specimen
 */
export function ClacksSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <div class="clacks-grid">
        <Clacks />
        <span>Looking for a companion…</span>
        <Clacks state="answered" />
        <span>Answered</span>
        <Clacks size="sm" />
        <span>sm, for an icon slot</span>
      </div>
      <div class="clacks-grid" data-density="desktop">
        <Clacks />
        <span>Desktop: Asking the network for speakers…</span>
      </div>
    </div>
  );
}

/* --------------------------------------------- Artwork, Tooltip, Divider */

const ART =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#0f7d7a"/><rect y="28" width="48" height="20" fill="#0a5654"/><circle cx="34" cy="14" r="5" fill="#f7e27a"/></svg>',
  );
const FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#1d4ea8"/><circle cx="8" cy="8" r="3" fill="#fff"/></svg>',
  );

/**
 * Artwork: image, favicon, placeholder and disc at their sizes.
 * @returns The specimen
 */
export function ArtworkSpecimen(): JSX.Element {
  return (
    <Cluster gap="4">
      <Artwork kind="image" size="md" src={ART} />
      <Artwork kind="image" size="lg" src={ART} />
      <Artwork kind="favicon" size="sm" src={FAVICON} />
      <Artwork kind="placeholder" size="md" />
      <Artwork kind="placeholder" size="lg" />
      <Artwork kind="disc" size="md" glyph="speaker" />
      <Artwork kind="disc" size="lg" glyph="monitor" />
      <Artwork kind="placeholder" size="sm" />
      <Artwork kind="disc" size="sm" glyph="speaker" />
      <Artwork kind="image" size="md" src="data:image/png;base64,broken" />
    </Cluster>
  );
}

/**
 * Tooltip: hover or focus the button; it shows after the delay, at once on focus.
 * @returns The specimen
 */
export function TooltipSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <Cluster>
        <IconButton glyph="refresh" label="Measure video sync again" tooltip />
        <Tooltip content="Settings">
          <IconButton glyph="settings" label="Settings" kind="tonal" />
        </Tooltip>
      </Cluster>
      <span class="label">Shown (the real tooltip, opened without a hover)</span>
      <div class="tooltip-stage">
        <Tooltip content="Measure video sync again" defaultOpen>
          <IconButton glyph="refresh" label="Measure video sync again" />
        </Tooltip>
      </div>
    </div>
  );
}

/**
 * Divider: the hairline between groups in a card.
 * @returns The specimen
 */
export function DividerSpecimen(): JSX.Element {
  return (
    <div class="on-card stack">
      <span>Rooms · 2 of 14 chosen</span>
      <Divider />
      <span>Cast to 2 rooms</span>
    </div>
  );
}

/* ------------------------------------------------------------------- Chip */

/**
 * Chip: input kind, every state of its remove button.
 * @returns The specimen
 */
export function ChipSpecimen(): JSX.Element {
  const [ips, setIps] = useState(['192.168.1.47', '192.168.1.52', '192.168.1.60']);
  return (
    <div class="stack" data-density="desktop">
      <Cluster gap="3">
        {ips.map((ip) => (
          <Chip
            key={ip}
            label={ip}
            mono
            removeLabel={`Remove ${ip}`}
            onRemove={() => setIps(ips.filter((x) => x !== ip))}
          />
        ))}
      </Cluster>
      <Cluster gap="3">
        {FORCED.map((f) => (
          <Chip key={f} label={f} removeLabel={`Remove ${f}`} onRemove={noop} data-force={f} />
        ))}
        <Chip label="removing" removeLabel="Remove" onRemove={noop} disabled />
      </Cluster>
    </div>
  );
}

/* ---------------------------------------------- SectionHeader, BrandBlock */

/**
 * SectionHeader: card and live.
 * @returns The specimen
 */
export function SectionHeaderSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <SectionHeader kind="live" level={2} title="Casting now" />
      <div class="on-card">
        <SectionHeader
          level={3}
          title="Finer points"
          meta="3 settings"
          actions={<Button size="sm">Reset</Button>}
        />
      </div>
    </div>
  );
}

/**
 * BrandBlock: the popup header, the wide rail, lit while casting.
 * @returns The specimen
 */
export function BrandBlockSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <Cluster gap="4">
        <BrandBlock name="Thaumic Cast" />
        <BrandBlock name="Thaumic Cast" lit />
      </Cluster>
      <div class="on-container">
        <BrandBlock name="Thaumic Cast" kind="rail" version="Version 0.12.0" />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- NavItem */

/**
 * NavItem: current, every state, disabled.
 * @returns The specimen
 */
export function NavItemSpecimen(): JSX.Element {
  return (
    <div class="on-container nav-demo" data-density="desktop">
      <NavItem icon="speaker" label="Speakers" href="#speakers" current onNavigate={noop} />
      <NavItem icon="server" label="Server" href="#server" onNavigate={noop} />
      {FORCED.map((f) => (
        <NavItem
          key={f}
          icon="settings"
          label={`Settings (${f})`}
          href="#settings"
          onNavigate={noop}
          data-force={f}
        />
      ))}
      <NavItem
        icon="speaker"
        label="Current, focused"
        href="#speakers"
        current
        onNavigate={noop}
        data-force="focus"
      />
      <NavItem icon="home" label="Disabled" href="#home" disabled />
    </div>
  );
}

/* ---------------------------------------------------- StepIndicator, Meter */

/**
 * StepIndicator: popup and desktop sizes.
 * @returns The specimen
 */
export function StepIndicatorSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <div class="fit">
        <StepIndicator
          current={1}
          total={4}
          labels={['Welcome', 'Companion', 'Speakers', 'Ready']}
        />
      </div>
      <div data-density="desktop" class="fit">
        <StepIndicator current={2} total={5} />
      </div>
    </div>
  );
}

/**
 * Meter: a list at RoomCard width (normal, low and empty), and one at the narrowest it takes.
 * Each is stacked, so the bars share the width and the readings end at one edge.
 * @returns The specimen
 */
export function MeterSpecimen(): JSX.Element {
  return (
    <div data-density="desktop" class="stack">
      <div class="stack meter-list">
        <Meter
          name="Kitchen"
          label="Kitchen reserve"
          value={1240}
          max={2000}
          low={500}
          valueText="1240 ms"
        />
        <Meter
          name="Study"
          label="Study reserve"
          value={380}
          max={2000}
          low={500}
          valueText="380 ms"
        />
        <Meter
          name="Living room"
          label="Living room reserve"
          value={0}
          max={2000}
          low={500}
          valueText="0 ms"
        />
      </div>
      <p class="label">At its narrowest (12rem)</p>
      <div class="meter-narrow">
        <Meter
          name="Downstairs bathroom"
          label="Downstairs bathroom reserve"
          value={1900}
          max={2000}
          low={500}
          valueText="1900 ms"
        />
      </div>
    </div>
  );
}
