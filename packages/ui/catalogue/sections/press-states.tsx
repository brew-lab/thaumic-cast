/*
 * Press and focus (#press-states): the shape grammar on every pressable atom (DESIGN.md
 * F-grammar). Hover is colour, focus-visible is the bevel and the ring, and a press morphs to
 * the bevel and back, held for the morph so a quick click shows it in full. The first rows
 * are live, including controls that go busy from their own press (a press that makes a
 * control busy plays out, §11 call 78) and a link Button that Enter alone presses; the rest
 * draw each state with data-force. The catalogue's frame recordings and the press tests
 * (tests/press.pw.ts) use the live rows.
 */
import { Fragment, type JSX } from 'preact';
import { useState } from 'preact/hooks';
import { Button, type ButtonProps } from '../../src/Button';
import { Checkbox } from '../../src/Checkbox';
import { Chip } from '../../src/Chip';
import { Cluster } from '../../src/Cluster';
import { Disclosure } from '../../src/Disclosure';
import { IconButton } from '../../src/IconButton';
import { NavItem } from '../../src/NavItem';
import { SegmentedControl } from '../../src/SegmentedControl';
import { Switch } from '../../src/Switch';

/** One Button kind, as the section shows it. */
interface Kind {
  /** Its name, for the tests and the frames. */
  name: string;
  /** Its props. */
  props: Partial<ButtonProps>;
  /** Its words. */
  label: string;
}

const KINDS: Kind[] = [
  { name: 'filled', props: { kind: 'filled', icon: 'cast' }, label: 'Cast' },
  { name: 'filled-danger', props: { kind: 'filled', danger: true, icon: 'stop' }, label: 'Stop' },
  { name: 'tonal', props: { kind: 'tonal' }, label: 'Connect' },
  { name: 'tonal-danger', props: { kind: 'tonal', danger: true }, label: 'Forget' },
  { name: 'outline', props: { kind: 'outline' }, label: 'Cancel' },
  { name: 'quiet', props: { kind: 'quiet', icon: 'plus' }, label: 'Add a room' },
  { name: 'link', props: { kind: 'link' }, label: 'Read more' },
];

const FORCED = ['hover', 'focus', 'press'] as const;

const SEGMENTS = [
  { value: 'auto', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const noop = (): void => undefined;

/** How long the live busy controls stay busy: long enough to press again while busy. */
const BUSY_FOR_MS = 2500;

/**
 * Waits, as an action does.
 * @param ms - How long
 * @returns A promise that resolves after it
 */
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Press and focus: every Button kind and every other pressable atom, live and forced.
 * @returns The specimen
 */
export function PressStatesSpecimen(): JSX.Element {
  const [on, setOn] = useState(false);
  const [checked, setChecked] = useState(false);
  const [theme, setTheme] = useState('auto');
  const [iconBusy, setIconBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [launch, setLaunch] = useState(false);
  return (
    <div class="press-states">
      <div data-live="">
        {(['sm', 'md'] as const).map((size) => (
          <Fragment key={size}>
            <p class="label">Live, {size}</p>
            <Cluster gap="3">
              {KINDS.map(({ name, props, label }) => (
                <Button key={name} {...props} size={size} onClick={noop} data-kind={name}>
                  {label}
                </Button>
              ))}
            </Cluster>
          </Fragment>
        ))}
        <p class="label">Live, the rest</p>
        <Cluster gap="3">
          <IconButton glyph="settings" label="Settings" size="sm" data-kind="icon-sm" />
          <IconButton glyph="settings" label="Settings" data-kind="icon-md" />
          <IconButton glyph="settings" label="Settings" kind="tonal" data-kind="icon-tonal" />
          <Chip label="192.168.1.47" mono removeLabel="Remove 192.168.1.47" onRemove={noop} />
          <Switch label="Video sync" checked={on} onChange={setOn} data-kind="switch" />
          <Checkbox label="Kitchen" checked={checked} onChange={setChecked} />
          <SegmentedControl label="Theme" value={theme} onChange={setTheme} options={SEGMENTS} />
          <span>
            <NavItem icon="settings" label="Settings" href="#press-states" onNavigate={noop} />
          </span>
          <Disclosure label="Advanced">
            <p>Folded content.</p>
          </Disclosure>
        </Cluster>
        <p class="label">Live, busy from the press, and a link</p>
        <Cluster gap="3">
          <Button kind="tonal" onAction={() => wait(BUSY_FOR_MS)} data-kind="async">
            Connect
          </Button>
          <Button
            kind="filled"
            icon="cast"
            onAction={() => wait(BUSY_FOR_MS)}
            labels={{ busy: 'Casting…' }}
            data-kind="async-filled"
          >
            Cast
          </Button>
          <IconButton
            glyph="refresh"
            label="Refresh"
            busy={iconBusy}
            onPress={() => {
              setIconBusy(true);
              setTimeout(() => setIconBusy(false), BUSY_FOR_MS);
            }}
            data-kind="icon-async"
          />
          <Switch
            label="Launch at login"
            checked={launch}
            busy={saving}
            data-kind="switch-async"
            onChange={(next) => {
              setSaving(true);
              setTimeout(() => {
                setLaunch(next);
                setSaving(false);
              }, BUSY_FOR_MS);
            }}
          />
          <Button kind="link" href="#press-states" data-kind="link-href">
            Read the guide
          </Button>
        </Cluster>
      </div>
      {FORCED.map((state) => (
        <Fragment key={state}>
          <p class="label">{state}</p>
          <Cluster gap="3">
            {KINDS.map(({ name, props, label }) => (
              <Button key={name} {...props} size="sm" data-force={state}>
                {label}
              </Button>
            ))}
            <IconButton glyph="settings" label="Settings" data-force={state} />
            <Chip label="Chip" removeLabel="Remove chip" onRemove={noop} data-force={state} />
            <Switch label={`Switch, ${state}`} checked={false} onChange={noop} data-force={state} />
            <Switch label={`On, ${state}`} checked onChange={noop} data-force={state} />
            <Checkbox label={`Box, ${state}`} checked={false} onChange={noop} data-force={state} />
            <Checkbox label={`Ticked, ${state}`} checked onChange={noop} data-force={state} />
            <SegmentedControl
              label={`Theme, ${state}`}
              hideLabel
              value="auto"
              onChange={noop}
              options={SEGMENTS}
              data-force={state}
            />
            <span>
              <NavItem
                icon="settings"
                label="Settings"
                href="#press-states"
                onNavigate={noop}
                data-force={state}
              />
            </span>
            <Disclosure label={`Fold, ${state}`} data-force={state}>
              <p>Folded content.</p>
            </Disclosure>
          </Cluster>
        </Fragment>
      ))}
    </div>
  );
}
