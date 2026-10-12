/*
 * Button states (#button-states): the real Button changing state, on every kind and in the
 * places it changes state in the apps (DESIGN.md A-button, "Changing state"; §11 call 75).
 * The Button fits what it shows: a change morphs its width, the old words fade up and out,
 * then the new ones fade in.
 *
 * Every Button here is the real Button with a pretend action. A press starts it; the action
 * settles, and a result goes back to idle, one step later. With the loop on, a step is a
 * timer and idle Buttons press themselves; with it off (always under automation), a step
 * waits for "Next step", so each change can be watched, measured or recorded on its own.
 */
import type { JSX, RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useAnnouncer } from '../../src/Announcer';
import { Badge, type BadgeTone } from '../../src/Badge';
import { Button, type ButtonProps } from '../../src/Button';
import type { ActionLabels } from '../../src/Button/action';
import { Card } from '../../src/Card';
import { Cluster } from '../../src/Cluster';
import type { GlyphName } from '../../src/Icon/glyphs';
import { SettingsRow } from '../../src/SettingsRow';
import { Switch } from '../../src/Switch';
import { TextInput } from '../../src/TextInput';

/** One real case from the inventory: its words, its glyph and how its action ends. */
interface Case {
  /** The idle words. */
  idle: string;
  /** The busy, done and failed words. */
  labels: ActionLabels;
  /** The idle glyph. */
  icon?: GlyphName;
  /** How each run ends, in turn. */
  outcomes: ('resolve' | 'reject')[];
}

const ADD: Case = {
  idle: 'Add speaker',
  labels: { busy: 'Knocking politely…', done: 'Added' },
  outcomes: ['resolve'],
};
const CONNECT: Case = {
  idle: 'Connect',
  labels: { busy: 'Connecting…', failed: 'Try again' },
  outcomes: ['resolve', 'reject'],
};
// Stop and Stop all casts keep their words while busy: only the square becomes the Clacks.
const STOP: Case = { idle: 'Stop', labels: {}, icon: 'stop', outcomes: ['resolve'] };
const STOP_ALL: Case = { idle: 'Stop all casts', labels: {}, icon: 'stop', outcomes: ['resolve'] };
const RESTART: Case = {
  idle: 'Restart Thaumic Cast',
  labels: { busy: 'Restarting…' },
  icon: 'refresh',
  outcomes: ['resolve'],
};
const CAST: Case = {
  idle: 'Cast to 3 rooms',
  labels: { busy: 'Starting…', failed: 'Did not start' },
  icon: 'cast',
  outcomes: ['reject'],
};

/** The three cases every kind runs: long to short, short to long, and words that stay. */
const MATRIX_CASES: { title: string; c: Case }[] = [
  { title: 'Add speaker → Knocking politely… → Added', c: ADD },
  { title: 'Connect → Connecting… → Connect → Connecting… → Try again', c: CONNECT },
  { title: 'Stop → Stop, the square to the Clacks', c: STOP },
];

/** A kind as the specimen names it, and the Button props that draw it. */
interface Kind {
  /** The row heading. */
  title: string;
  /** The Button props. */
  props: Pick<ButtonProps, 'kind' | 'danger'>;
}

const KINDS: Kind[] = [
  { title: 'filled', props: { kind: 'filled' } },
  { title: 'tonal', props: { kind: 'tonal' } },
  { title: 'outline', props: { kind: 'outline' } },
  { title: 'quiet', props: { kind: 'quiet' } },
  { title: 'danger', props: { kind: 'filled', danger: true } },
  { title: 'soft danger', props: { kind: 'tonal', danger: true } },
];

/** The block-size check's kinds: every kind, the link included. */
const BLOCK_KINDS: Kind[] = [...KINDS, { title: 'link', props: { kind: 'link' } }];

/** The block-size check's cases: one without a glyph and one with, each to done and failed. */
const BLOCK_CASES: Case[] = [
  {
    idle: 'Connect',
    labels: { busy: 'Connecting…', done: 'Connected', failed: 'Try again' },
    outcomes: ['resolve', 'reject'],
  },
  {
    idle: 'Refresh',
    labels: { busy: 'Refreshing…', done: 'Refreshed', failed: 'Try again' },
    icon: 'refresh',
    outcomes: ['resolve', 'reject'],
  },
];

/** The block-size check's columns: each size in each density. */
const BLOCK_COLUMNS = (['popup', 'desktop'] as const).flatMap((density) =>
  (['sm', 'md'] as const).map((size) => ({ density, size })),
);

/** The Badge tones, the busy one with the Clacks among them. */
const BADGE_TONES: BadgeTone[] = ['neutral', 'busy', 'casting', 'warning', 'danger'];

/* ------------------------------------------------------------------- steps */

/** How long a step lasts with the loop on, in ms: long enough to read each state. */
const STEP_MS = 1600;

/** The specimen's switches and the steps waiting for "Next step", for both scheme panels. */
const steps = {
  // Automation (the behaviour tests and recordings) steps by hand; a person gets the loop.
  loop: typeof navigator === 'undefined' || !navigator.webdriver,
  slow: false,
  waiting: new Set<() => void>(),
  listeners: new Set<() => void>(),
};

/** Tells every subscriber that a switch changed. */
const notify = (): void => {
  for (const listener of steps.listeners) listener();
};

/**
 * One step, in ms: five times longer while slowed.
 * @returns The step
 */
const stepMs = (): number => STEP_MS * (steps.slow ? 5 : 1);

/**
 * Runs `fn` one step later: after a step's time with the loop on, else at "Next step".
 * @param fn - What the step does
 */
function later(fn: () => void): void {
  if (steps.loop) setTimeout(fn, stepMs());
  else steps.waiting.add(fn);
}

/** Runs every step waiting for "Next step". */
function nextStep(): void {
  const waiting = [...steps.waiting];
  steps.waiting.clear();
  for (const fn of waiting) fn();
}

/**
 * Subscribes a component to the switches.
 * @returns The switches
 */
function useSteps(): typeof steps {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const bump = (): void => setVersion((n) => n + 1);
    steps.listeners.add(bump);
    return () => {
      steps.listeners.delete(bump);
    };
  }, []);
  return steps;
}

/**
 * Whether the specimen is out of view or the page hidden, so the loop does not press.
 * @param el - An element in the specimen
 * @returns True when nobody can see it
 */
const unseen = (el: Element | null): boolean =>
  document.hidden || !!el?.closest('.section')?.hasAttribute('data-offscreen');

/* -------------------------------------------------------------- the buttons */

/**
 * With the loop on, presses the Button in `host` every step while it is idle, unless nobody
 * can see it.
 * @param host - The element round the Button
 * @param on - Whether to press
 */
function useLoop(host: RefObject<HTMLElement>, on: boolean): void {
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => {
      if (!unseen(host.current)) host.current?.querySelector('button')?.click();
    }, stepMs());
    return () => clearInterval(timer);
  }, [on]);
}

/** Props for {@link CaseButton}. */
interface CaseButtonProps extends Pick<ButtonProps, 'kind' | 'danger' | 'size' | 'fullWidth'> {
  /** The case it runs. */
  c: Case;
}

/**
 * The real Button on a case: its action settles a step after the press, and a result goes
 * back to idle a step after that. With the loop on, it presses itself a step after idle.
 * @param props - Component props
 * @param props.c - The case
 * @returns The Button
 */
function CaseButton({ c, ...props }: CaseButtonProps): JSX.Element {
  const { loop } = useSteps();
  const [reset, setReset] = useState(0);
  const [idle, setIdle] = useState(true);
  const runs = useRef(0);
  const host = useRef<HTMLSpanElement>(null);

  const action = (): Promise<void> => {
    setIdle(false);
    const outcome = c.outcomes[runs.current++ % c.outcomes.length];
    return new Promise<void>((resolve, reject) =>
      later(() => {
        const settles = outcome === 'resolve' ? c.labels.done : c.labels.failed;
        if (settles) {
          later(() => {
            setReset((n) => n + 1);
            setIdle(true);
          });
        } else setIdle(true);
        if (outcome === 'resolve') resolve();
        else reject(new Error('demo'));
      }),
    );
  };

  useLoop(host, loop && idle);

  return (
    <span ref={host} class="states-host" data-case={c.idle}>
      <Button {...props} icon={c.icon} onAction={action} labels={c.labels} resetKey={reset}>
        {c.idle}
      </Button>
    </span>
  );
}

/**
 * CopyField's Button after a value: the result is held from outside (`status`), with no busy
 * step, and goes back a step later.
 * @returns The Button
 */
function CopyButton(): JSX.Element {
  const { say } = useAnnouncer();
  const { loop } = useSteps();
  const [done, setDone] = useState(false);
  const host = useRef<HTMLSpanElement>(null);
  useLoop(host, loop && !done);
  return (
    <span ref={host} class="states-host" data-case="Copy address">
      <Button
        kind="quiet"
        icon="copy"
        flush
        status={done ? 'done' : 'idle'}
        labels={{ done: 'Copied' }}
        onClick={() => {
          if (done) return;
          setDone(true);
          say('Copied');
          later(() => setDone(false));
        }}
      >
        Copy address
      </Button>
    </span>
  );
}

/* ------------------------------------------------------------ the specimen */

/**
 * Button states: every kind on the long, short and unchanged cases, then in context.
 * @returns The specimen
 */
export function ButtonStatesSpecimen(): JSX.Element {
  const { loop, slow } = useSteps();
  const [address, setAddress] = useState('192.168.1.20');
  return (
    <div class="stack states">
      <div class="states-controls">
        <Switch
          label="Loop the demo"
          checked={loop}
          onChange={(on) => {
            steps.loop = on;
            if (on) for (const fn of steps.waiting) setTimeout(fn, stepMs());
            if (on) steps.waiting.clear();
            notify();
          }}
        />
        <Switch
          label="Slow it down five times"
          checked={slow}
          onChange={(on) => {
            steps.slow = on;
            document.documentElement.toggleAttribute('data-states-slow', on);
            notify();
          }}
        />
        <Cluster>
          <Button kind="outline" onClick={nextStep} disabled={loop} data-next-step="">
            Next step
          </Button>
        </Cluster>
      </div>
      <p class="label">
        Press any Button to start it. Long to short: Knocking politely… to Added, Connecting… to
        Connect. Short to long: the reverse. Stop keeps its words; only its glyph changes.
      </p>
      <div class="states-matrix" role="group" aria-label="Every kind">
        <span />
        {MATRIX_CASES.map(({ title }) => (
          <span key={title} class="token-name">
            {title}
          </span>
        ))}
        {KINDS.map((k) => (
          <div key={k.title} class="states-row" data-kind={k.title}>
            <span class="token-name">{k.title}</span>
            {MATRIX_CASES.map(({ title, c }) => (
              <div key={title} class="states-cell">
                <CaseButton {...k.props} c={c} />
              </div>
            ))}
          </div>
        ))}
      </div>
      <p class="label">In context</p>
      <div class="states-contexts" data-density="desktop">
        <div class="stack" data-context="field">
          <p class="token-name">Beside a field (AddressField's line: the field gives way)</p>
          <div class="states-field">
            <TextInput
              kind="address"
              value={address}
              onInput={setAddress}
              aria-label="Desktop address"
              data-neighbour=""
            />
            <CaseButton c={CONNECT} />
          </div>
          <p class="token-name">Beside a capped field (the speaker kind: the end is free)</p>
          <div class="states-field" data-capped="">
            <TextInput
              kind="address"
              value={address}
              onInput={setAddress}
              aria-label="Speaker address"
              data-neighbour=""
            />
            <CaseButton c={ADD} />
          </div>
        </div>
        <div class="stack" data-context="row">
          <p class="token-name">In a row, at the end (the Speakers header)</p>
          <Cluster justify="end">
            <Button icon="refresh" size="md" data-neighbour="">
              Ask again
            </Button>
            <CaseButton kind="filled" danger size="md" c={STOP_ALL} />
          </Cluster>
          <p class="token-name">In a row, at the start</p>
          <Cluster>
            <CaseButton c={CONNECT} />
            <Button kind="outline" data-neighbour="">
              Cancel
            </Button>
          </Cluster>
        </div>
        <div class="stack states-narrow" data-context="full">
          <p class="token-name">Full width (the popup's Cast: the width holds)</p>
          <CaseButton kind="filled" size="md" fullWidth c={CAST} />
        </div>
        <div class="stack" data-context="settings">
          <p class="token-name">In a SettingsRow (end-aligned: it grows towards the start)</p>
          <Card title="Actions" level={4}>
            <SettingsRow
              label="Restart"
              help="Stops every cast and starts the server again."
              controlWidth="action"
              control={<CaseButton c={RESTART} />}
            />
          </Card>
          <p class="token-name">After a value (CopyField)</p>
          <p class="states-value">
            <span class="mono" data-neighbour="">
              192.168.1.20:49400
            </span>
            <CopyButton />
          </p>
        </div>
      </div>
      <p class="label">
        Block size: every kind, size and density, with and without a glyph, each alone on its line.
        A change of state never changes the height of the Button or of its line.
      </p>
      <div class="states-blocks" role="group" aria-label="Block size" data-context="blocks">
        <span />
        {BLOCK_COLUMNS.map(({ density, size }) => (
          <span key={`${density}-${size}`} class="token-name">
            {density} {size}
          </span>
        ))}
        {BLOCK_KINDS.map((k) => (
          <div key={k.title} class="states-row" data-kind={k.title}>
            <span class="token-name">{k.title}</span>
            {BLOCK_COLUMNS.map(({ density, size }) => (
              <div
                key={`${density}-${size}`}
                class="states-lines"
                data-density={density}
                data-size={size}
              >
                {BLOCK_CASES.map((c) => (
                  <div key={c.idle} class="states-line">
                    <CaseButton {...k.props} size={size} c={c} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div class="states-badges" data-context="badges">
        {BADGE_TONES.map((tone) => (
          <div key={tone} class="states-line" data-tone-case={tone}>
            <Badge tone={tone} label={tone === 'busy' ? 'Checking' : 'In step'} />
          </div>
        ))}
      </div>
    </div>
  );
}
