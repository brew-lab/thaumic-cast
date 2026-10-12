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
  { title: 'link', props: { kind: 'link', icon: 'external' }, label: 'Update available' },
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
      <p class="label">Sizes: popup sm and md, desktop sm and md</p>
      <Cluster>
        <Button icon="refresh" size="sm">
          Ask again
        </Button>
        <Button icon="refresh">Ask again</Button>
      </Cluster>
      <div data-density="desktop">
        <Cluster>
          <Button icon="refresh" size="sm">
            Ask again
          </Button>
          <Button icon="refresh">Ask again</Button>
        </Cluster>
      </div>
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
      <p class="label">Desktop density, sm 2.5rem and md 2.75rem, with the Tooltip</p>
      <div data-density="desktop">
        <Cluster gap="4">
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
      <p class="label">Desktop density</p>
      <div data-density="desktop" class="narrow">
        <TextInput
          kind="address"
          aria-label="Speaker address"
          value="192.168.1.47"
          onInput={noop}
          inputMode="decimal"
        />
      </div>
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
      <div data-density="desktop">
        <Select
          label="Head start (desktop)"
          value={250}
          options={[
            { value: 0, label: 'Off' },
            { value: 250, label: '250 ms' },
          ]}
          onChange={noop}
        />
      </div>
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
  const row = (child: JSX.Element, value: string): JSX.Element => (
    <div class="slider-row">
      {child}
      <span class="num value-box">{value}</span>
    </div>
  );
  return (
    <div class="stack narrow">
      {row(<Slider label="Kitchen volume" value={volume} onChange={setVolume} />, String(volume))}
      {row(
        <Slider
          label="Fine-tune"
          min={-500}
          max={500}
          step={10}
          centre={0}
          value={trim}
          onChange={setTrim}
          format={(v) => `${v > 0 ? '+' : ''}${v} ms`}
        />,
        `${trim > 0 ? '+' : ''}${trim} ms`,
      )}
      {FORCED.map((f) => (
        <div key={f}>
          <span class="label">{f}</span>
          {row(<Slider label={`Volume, ${f}`} value={46} onChange={noop} data-force={f} />, '46')}
        </div>
      ))}
      <span class="label">disabled (joining)</span>
      {row(<Slider label="Bedroom volume" value={30} onChange={noop} disabled />, '30')}
      <span class="label">not known yet</span>
      {row(
        <Slider
          label="Study volume"
          value={undefined}
          unknownText="Not known yet"
          onChange={noop}
        />,
        '…',
      )}
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
      <Cluster gap="3">
        <Clacks /> <span>Looking for a companion…</span>
      </Cluster>
      <Cluster gap="3">
        <Clacks state="answered" /> <span>Answered</span>
      </Cluster>
      <Cluster gap="3">
        <Clacks size="sm" /> <span>sm, for an icon slot</span>
      </Cluster>
      <div data-density="desktop">
        <Cluster gap="3">
          <Clacks /> <span>Desktop: Asking the network for speakers…</span>
        </Cluster>
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
      <Cluster gap="4">
        <IconButton glyph="refresh" label="Measure video sync again" tooltip />
        <Tooltip content="Settings">
          <IconButton glyph="settings" label="Settings" kind="tonal" />
        </Tooltip>
      </Cluster>
      <span class="tooltip-sample">Measure video sync again</span>
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
      <StepIndicator current={1} total={4} labels={['Welcome', 'Companion', 'Speakers', 'Ready']} />
      <div data-density="desktop">
        <StepIndicator current={2} total={5} />
      </div>
    </div>
  );
}

/**
 * Meter: normal and low.
 * @returns The specimen
 */
export function MeterSpecimen(): JSX.Element {
  return (
    <div class="stack" data-density="desktop">
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
    </div>
  );
}
