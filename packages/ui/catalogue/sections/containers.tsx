import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { AddressField, type AddressResult } from '../../src/AddressField';
import { Button } from '../../src/Button';
import { Card } from '../../src/Card';
import { ChoiceGroup } from '../../src/ChoiceGroup';
import { Cluster } from '../../src/Cluster';
import { CopyField } from '../../src/CopyField';
import { DescriptionList } from '../../src/DescriptionList';
import { EmptyState } from '../../src/EmptyState';
import { Rail, type RailItem } from '../../src/Rail';
import { SettingsSection } from '../../src/SettingsSection';
import { Notice } from '../../src/Notice';
import { NoticeLine } from '../../src/NoticeLine';
import { Toast } from '../../src/Toast';
import { SettingsRows } from './molecules';

const noop = (): void => {};

/** The container ranges (DESIGN.md F-containers), by name. */
type Range = 'compact' | 'medium' | 'wide';

/** Each frame's intended width in rem, inside its range. */
const FRAME_REM: Record<Range, number> = { compact: 22, medium: 36, wide: 52 };

/** The two densities a frame is drawn at. */
type Density = 'popup' | 'desktop';

/**
 * Names the container range a width in rem falls in (compact under 25rem, medium to 45rem,
 * wide from 45rem).
 * @param rem - The width in rem
 * @returns The range
 */
export function rangeOf(rem: number): Range {
  if (rem < 25) return 'compact';
  return rem < 45 ? 'medium' : 'wide';
}

/**
 * Measures an element's inline size in rem, live.
 * @returns A ref for the element and its width in rem (0 until measured)
 */
function useWidthRem(): [{ current: HTMLDivElement | null }, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [rem, setRem] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const observer = new ResizeObserver(([entry]) => {
      setRem(Math.round((entry.borderBoxSize?.[0]?.inlineSize ?? 0) / root));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, rem];
}

/**
 * One frame of a fixed width in a container range, with a live readout of the width it is
 * drawn at. When the window is too narrow for it, the readout says which range it fell into,
 * so a narrow window never passes off a compact frame as medium.
 * @param props - Component props
 * @param props.range - The range the frame is meant to show
 * @param props.density - The density inside it
 * @param props.children - The specimen
 * @returns The frame
 */
function Frame({
  range,
  density,
  children,
}: {
  range: Range;
  density: Density;
  children: ComponentChildren;
}): JSX.Element {
  const [ref, rem] = useWidthRem();
  const drawn = rem ? rangeOf(rem) : range;
  return (
    <div class="frame" data-range={range} style={{ '--frame-rem': FRAME_REM[range] }}>
      <p class="label">
        {range} · {density} · {FRAME_REM[range]}rem
        {drawn !== range && ` (the window is too narrow: drawn at ${rem}rem, ${drawn})`}
      </p>
      <div ref={ref} class="frame-box" data-density={density}>
        {children}
      </div>
    </div>
  );
}

/**
 * A specimen in compact, medium and wide frames, at both densities.
 * @param props - Component props
 * @param props.title - What the frames show
 * @param props.children - The specimen, drawn once per frame
 * @returns The frames
 */
export function Frames({
  title,
  children,
}: {
  title: string;
  children: () => JSX.Element;
}): JSX.Element {
  return (
    <div class="stack">
      <h3 class="label">{title}</h3>
      {(['popup', 'desktop'] as const).map((density) => (
        <div key={density} class="frames">
          {(['compact', 'medium', 'wide'] as const).map((range) => (
            <Frame key={range} range={range} density={density}>
              {children()}
            </Frame>
          ))}
        </div>
      ))}
    </div>
  );
}

const answered: AddressResult = {
  ok: true,
  said: 'Thaumic Cast answered.',
  message: 'Thaumic Cast answered',
  detail: '12 ms',
};

const COPY = {
  done: 'Copied',
  refusedNote: 'The clipboard said no. Here it is, selected, to copy by hand.',
  unavailableNote: "This computer's address isn't known yet. Try again in a moment.",
};

/**
 * A server AddressField that holds its own value.
 * @returns The field
 */
function Address(): JSX.Element {
  const [value, setValue] = useState('http://192.168.1.20:49400');
  return (
    <AddressField
      kind="server"
      label="Server address"
      action={{ idle: 'Connect', busy: 'Connecting…', failed: 'Try again' }}
      value={value}
      onChange={setValue}
      onTest={() => Promise.resolve(answered)}
    />
  );
}

/**
 * A speaker AddressField: its IP field grows with its text where field-sizing exists.
 * @returns The field
 */
function SpeakerAddress(): JSX.Element {
  const [value, setValue] = useState('192.168.100.200');
  return (
    <AddressField
      kind="speaker"
      label="Add a speaker by IP address"
      action={{ idle: 'Add speaker', busy: 'Adding…', failed: 'Try again' }}
      value={value}
      onChange={setValue}
      onTest={() => Promise.resolve({ ok: true, said: 'Added.' })}
    />
  );
}

/**
 * Every container-query molecule in compact, medium and wide frames, at both densities
 * (DESIGN.md F-containers): the notices, the settings card, the choice group, the
 * description list and the empty state.
 * @returns The specimen
 */
export function ContainerFramesSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <Frames title="Notice: the action under the text below 25rem, beside it from 25rem">
        {() => (
          <div class="stack">
            <Notice
              tone="warning"
              lead="Kitchen may cut out soon"
              text="Its reserve is running low."
              action={{ label: 'Try again', onClick: noop }}
              onDismiss={noop}
              announce={false}
            />
            <NoticeLine tone="danger" lead="Kitchen did not join" onDismiss={noop} />
            <Toast
              text="Kitchen removed."
              action={{ label: 'Undo', onClick: noop }}
              onDismiss={noop}
            />
          </div>
        )}
      </Frames>
      <Frames title="SettingsRow on its section's subgrid (from 25rem); wide adds the help column">
        {() => (
          <SettingsSection title="Audio" headingLevel={4}>
            <SettingsRows />
          </SettingsSection>
        )}
      </Frames>
      <Frames title="ChoiceGroup: one column below 25rem, option columns from 25rem">
        {() => (
          <Card>
            <ChoiceGroup
              legend="Quality"
              value="mid"
              onChange={noop}
              options={[
                { value: 'low', label: 'Economical', description: 'The least network.' },
                { value: 'mid', label: 'Sensible', description: 'Neither extravagant nor mean.' },
                { value: 'high', label: 'Luxurious', description: 'Every bit.' },
              ]}
            />
          </Card>
        )}
      </Frames>
      <Frames title="DescriptionList: pairs stack below 25rem and share one grid from 25rem">
        {() => (
          <Card>
            <DescriptionList
              kind="stat"
              rows={[
                { key: 'streams', term: 'Streams', value: '2', count: true },
                { key: 'speakers', term: 'Speakers', value: '12', count: true },
                { key: 'uptime', term: 'Running for', value: '3 hours' },
              ]}
            />
          </Card>
        )}
      </Frames>
      <Frames title="EmptyState: the art beside the words below 25rem, stacked from 25rem">
        {() => (
          <Card>
            <EmptyState
              title="No speakers yet"
              body="Speakers are listed here once the companion answers."
              action={<Button>Look again</Button>}
            />
          </Card>
        )}
      </Frames>
    </div>
  );
}

/**
 * The field-container molecules and the Cluster in every range, at both densities: the
 * address line (beside from 25rem), the speaker IP field that grows with its text, the copy
 * action (icon-only under 20rem) and the actions row that stacks under 25rem.
 * @returns The specimen
 */
export function ContainerFieldsSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <Frames title="AddressField: the action beside the field from 25rem">
        {() => (
          <div class="stack">
            <Address />
            <SpeakerAddress />
          </div>
        )}
      </Frames>
      <Frames title="CopyField: icon-only under 20rem of its field; the value wraps, never cut off">
        {() => (
          <CopyField
            value="http://192.168.1.20:49400/stream/4f2a/listen.flac"
            action="Copy URL"
            {...COPY}
          />
        )}
      </Frames>
      <div class="frames">
        <div class="frame" style={{ '--frame-rem': 18 }}>
          <p class="label">CopyField under 20rem · 18rem</p>
          <div class="frame-box" data-density="desktop">
            <CopyField value="192.168.1.20:49400" action="Copy address" {...COPY} />
          </div>
        </div>
      </div>
      <Frames title="Cluster stack: the actions stack full width under 25rem">
        {() => (
          <Cluster stack>
            <Button kind="outline">Cancel</Button>
            <Button kind="filled" danger>
              Stop all casts
            </Button>
          </Cluster>
        )}
      </Frames>
    </div>
  );
}

/**
 * One Rail, as the DesktopShell draws it, in an `app` container of the given width.
 * @param props - Component props
 * @param props.rem - The window's width in rem
 * @returns The rail in its window
 */
function RailWindow({ rem }: { rem: number }): JSX.Element {
  const narrow = rem < 45;
  return (
    <div class="frame" style={{ '--frame-rem': rem }}>
      <p class="label">
        {narrow ? 'Narrow rail' : 'Wide rail'} · a {rem}rem window
      </p>
      <div class="rail-window" data-density="desktop" data-rail={narrow ? 'narrow' : 'wide'}>
        <Rail
          brand={{ name: 'Thaumic Cast', version: 'Version 0.12.0' }}
          items={RAIL_ITEMS}
          current="#speakers"
          onNavigate={noop}
          navLabel={narrow ? 'Narrow rail' : 'Wide rail'}
        />
        <p class="rail-main">The view.</p>
      </div>
    </div>
  );
}

/**
 * The rail in a narrow window (under 45rem: the mark alone, icon-only NavItems with a
 * Tooltip on hover and focus) and in a wide one (the words, no Tooltip).
 * @returns The specimen
 */
export function RailSpecimen(): JSX.Element {
  return (
    <div class="frames">
      <RailWindow rem={40} />
      <RailWindow rem={52} />
    </div>
  );
}

/** The rail's destinations. */
const RAIL_ITEMS: RailItem[] = [
  { href: '#speakers', icon: 'speaker', label: 'Speakers' },
  { href: '#server', icon: 'server', label: 'Server' },
  { href: '#settings', icon: 'settings', label: 'Settings' },
];

/** The fluid steps the strip measures (DESIGN.md T-type, T-space). */
const FLUID_TYPE = ['--text-4', '--text-5', '--text-6', '--text-7', '--text-8'];
const FLUID_SPACE = ['--space-5', '--space-6', '--space-7', '--space-8'];

/**
 * One container of the fluid ramp, with every fluid step drawn and its computed px.
 * @param props - Component props
 * @param props.px - The container's width in px
 * @returns The strip
 */
function RampStrip({ px }: { px: number }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const [sizes, setSizes] = useState<Record<string, number>>({});
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const out: Record<string, number> = {};
    el.querySelectorAll<HTMLElement>('[data-step]').forEach((node) => {
      const step = node.dataset.step ?? '';
      const style = getComputedStyle(node);
      out[step] = Math.round(
        parseFloat(step.startsWith('--text') ? style.fontSize : style.inlineSize),
      );
    });
    setSizes(out);
  }, []);
  return (
    <div class="ramp" style={{ '--ramp-px': px }}>
      <p class="label">a {px} px container</p>
      <div ref={ref} class="ramp-box">
        {FLUID_TYPE.map((step) => (
          <p key={step} class="ramp-type" data-step={step} style={{ '--step': `var(${step})` }}>
            Aa <span class="num ramp-px">{sizes[step] ?? ''}</span>
          </p>
        ))}
        {FLUID_SPACE.map((step) => (
          <div key={step} class="ramp-space-row">
            <span class="ramp-space" data-step={step} style={{ '--step': `var(${step})` }} />
            <span class="num ramp-px">
              {step} {sizes[step] ?? ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The fluid ramp at 352, 640 and 960 px containers (F-fluid: 400 to 960), so a wrong slope
 * or a missing container shows, and a frame to drag through every range.
 * @returns The specimen
 */
export function FluidSpecimen(): JSX.Element {
  const [ref, rem] = useWidthRem();
  return (
    <div class="stack">
      <div class="ramps">
        <RampStrip px={352} />
        <RampStrip px={640} />
        <RampStrip px={960} />
      </div>
      <h3 class="label">
        Drag the corner to resize: {rem ? `${rem}rem, ${rangeOf(rem)}` : 'measuring'}
      </h3>
      <div ref={ref} class="resizable" data-density="desktop">
        <SettingsSection title="Speakers" headingLevel={4}>
          <SettingsRows />
        </SettingsSection>
        <Notice
          tone="info"
          lead="The rooms fold from eight"
          text="Search lives inside the fold."
          action={{ label: 'Open settings', onClick: noop }}
          announce={false}
        />
        <Card>
          <EmptyState title="No speakers yet" body="Speakers are listed here once they answer." />
        </Card>
      </div>
    </div>
  );
}
