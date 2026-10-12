import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { useAnnouncer } from '../../src/Announcer';
import { Cluster } from '../../src/Cluster';
import { GLYPH_NAMES, Icon } from '../../src/Icon';
import { COLORS, TOKEN_NAMES, type ColorName } from '../../src/tokens';
import { useScheme } from '../scheme';

const swatch = (token: string): JSX.CSSProperties => ({ '--swatch': `var(--${token})` });

/**
 * One colour token: its swatch, name and value in this scheme.
 * @param props - Component props
 * @param props.name - The token name, without the leading --
 * @returns The list item
 */
function Swatch({ name }: { name: string }): JSX.Element {
  const scheme = useScheme();
  const hex = name in COLORS ? COLORS[name as ColorName][scheme] : 'alias';
  return (
    <li class="swatch-item">
      <span class="swatch" style={swatch(name)} />
      <span class="token-name">--{name}</span>
      <span class="token-value mono">{hex}</span>
    </li>
  );
}

const SEMANTIC = [
  'ground',
  'surface',
  'container',
  'container-high',
  'on-surface',
  'on-surface-variant',
  'outline',
  'outline-variant',
  'divider',
  'inverse-surface',
  'on-inverse-surface',
  'primary',
  'on-primary',
  'primary-container',
  'on-primary-container',
  'secondary-container',
  'on-secondary-container',
  'focus',
  'ring-gap',
  'cast-badge',
  'on-cast-badge',
  'live-lamp',
  'on-danger',
  'track',
];

const STATUS = ['danger', 'warning', 'success', 'info'] as const;
const STATUS_GLYPH = {
  danger: 'danger',
  warning: 'warning',
  success: 'check',
  info: 'info',
} as const;
/**
 * What reads each status token, in the two pairs (T-colour): on its container, or the ink on a
 * surface. A component sets data-tone and reads --tone-*; this is where each set shows up.
 */
const STATUS_READERS: Record<(typeof STATUS)[number], { container: string; ink: string }> = {
  danger: {
    container: 'Notice, NoticeLine, Badge, Button tonal danger (Stop) and failed',
    ink: 'Button filled danger (Stop all casts), StatusDot failed, invalid and error edges and text',
  },
  warning: { container: 'Notice, NoticeLine, Badge', ink: 'Meter low' },
  success: { container: 'nothing in v1', ink: 'StatusDot connected, Clacks answered' },
  info: { container: 'Notice, NoticeLine', ink: 'nothing in v1' },
};

/**
 * One status set in this scheme: its four tokens with their values, the container sample,
 * the ink sample on a surface, and what reads each pair.
 * @param props - Component props
 * @param props.set - The set
 * @returns The row
 */
function StatusSet({ set }: { set: (typeof STATUS)[number] }): JSX.Element {
  const scheme = useScheme();
  const hex = (name: string): string => COLORS[name as ColorName][scheme];
  const tokens = [
    { name: `${set}-container`, value: hex(`${set}-container`) },
    { name: `on-${set}-container`, value: hex(`on-${set}-container`) },
    {
      name: `${set}-glyph`,
      value: scheme === 'light' ? hex(`on-${set}-container`) : hex(`${set}-ink`),
    },
    { name: `${set}-ink`, value: hex(`${set}-ink`) },
  ];
  const glyph = <Icon glyph={STATUS_GLYPH[set]} />;
  return (
    <li class="status-set" data-tone={set}>
      <ul class="status-tokens">
        {tokens.map((t) => (
          <li key={t.name} class="swatch-item">
            <span class="swatch" style={swatch(t.name)} />
            <span class="token-name">--{t.name}</span>
            <span class="token-value mono">{t.value}</span>
          </li>
        ))}
      </ul>
      <div class="status-samples">
        <p class="status-sample on-container">
          <span class="status-glyph">{glyph}</span>
          <span>
            <strong>{set}</strong> on its container
          </span>
        </p>
        <p class="status-sample on-surface">
          <span class="status-glyph">{glyph}</span>
          <span>
            <strong>{set}</strong> ink on a surface
          </span>
        </p>
      </div>
      <p class="status-readers">
        <span>
          <strong>Container:</strong> {STATUS_READERS[set].container}
        </span>
        <span>
          <strong>Ink:</strong> {STATUS_READERS[set].ink}
        </span>
      </p>
    </li>
  );
}

const LADDERS = ['purple', 'neutral', 'magenta'];
const STOPS = [20, 30, 40, 50, 60, 76, 90, 95];

/**
 * T-colour: semantic tokens, status sets and primitives.
 * @returns The specimen
 */
export function ColourSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <h3 class="label">Semantic</h3>
      <ul class="swatches">
        {SEMANTIC.map((n) => (
          <Swatch key={n} name={n} />
        ))}
      </ul>
      <h3 class="label">
        Status sets: each read on its container or as the ink on a surface, never by name
      </h3>
      <ul class="status-sets">
        {STATUS.map((s) => (
          <StatusSet key={s} set={s} />
        ))}
      </ul>
      <h3 class="label">The live gradient</h3>
      <p class="live-band">Casting now</p>
      <h3 class="label">Primitives (components never read these)</h3>
      <div class="ladders">
        {LADDERS.map((l) => (
          <div key={l} class="ladder">
            <span class="token-name">--{l}-*</span>
            <ul class="ladder-row">
              {STOPS.map((stop) => (
                <li key={stop} class="ladder-step" style={swatch(`${l}-${stop}`)}>
                  <span class="visually-hidden">
                    --{l}-{stop}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

const SAMPLE = 'Casting a very fine silence';

/**
 * T-type: the eight steps, faces and weights.
 * @returns The specimen
 */
export function TypeSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <ul class="type-steps">
        {[8, 7, 6, 5, 4, 3, 2, 1].map((n) => (
          <li
            key={n}
            class={n >= 5 ? 'type-step head' : 'type-step'}
            style={{
              '--step-size': `var(--text-${n})`,
              '--step-leading': `var(--leading-${n})`,
              '--step-tracking': `var(--tracking-${n})`,
            }}
          >
            <span class="token-name">--text-{n}</span>
            <span class="type-sample">{SAMPLE}</span>
          </li>
        ))}
      </ul>
      <p class="caps">Casting · In use · Geist caps at --text-1</p>
      <p>
        Body at <span class="weight-body">400 (--weight-body)</span> and{' '}
        <span class="weight-strong">600 (--weight-strong)</span>. Numbers are tabular:{' '}
        <span class="num">0123456789</span>.
      </p>
    </div>
  );
}

/**
 * T-space: every step as a bar.
 * @returns The specimen
 */
export function SpaceSpecimen(): JSX.Element {
  const steps = TOKEN_NAMES.filter((t) => t.startsWith('--space-'));
  return (
    <ul class="bars">
      {steps.map((t) => (
        <li key={t} class="bar-row">
          <span class="token-name">{t}</span>
          <span class="bar" style={{ '--bar': `var(${t})` }} />
        </li>
      ))}
    </ul>
  );
}

const RADII = [
  'radius-pressed',
  'radius-control',
  'radius-group',
  'radius-card',
  'radius-dialog',
  'radius-full',
];

/**
 * T-shape: radii, the three interaction shapes and the two lines.
 * @returns The specimen
 */
export function ShapeSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <h3 class="label">Radii</h3>
      <ul class="shapes">
        {RADII.map((r) => (
          <li key={r} class="shape-item">
            <span class="shape" style={{ '--shape-radius': `var(--${r})` }} />
            <span class="token-name">--{r}</span>
          </li>
        ))}
      </ul>
      <h3 class="label">
        Interaction: rest, then hover (colour only), then focus (the bevel and the ring), then press
        (the bevel and the 12 % layer; nothing scales)
      </h3>
      <ul class="shapes">
        <li class="shape-item">
          <span class="shape" style={{ '--shape-radius': 'var(--radius-control)' }} />
          <span class="token-name">rest</span>
        </li>
        <li class="shape-item">
          <span class="shape hovered" style={{ '--shape-radius': 'var(--radius-control)' }} />
          <span class="token-name">hover: 8 %</span>
        </li>
        <li class="shape-item">
          <span class="shape bevel focused" />
          <span class="token-name">focus: --shape-bevel + ring</span>
        </li>
        <li class="shape-item">
          <span class="shape bevel pressed" />
          <span class="token-name">press: --shape-bevel + 12 %</span>
        </li>
      </ul>
      <h3 class="label">Lines</h3>
      <div class="lines">
        <span class="line hair" />
        <span class="token-name">--line-hair</span>
        <span class="line bold" />
        <span class="token-name">--line-bold</span>
      </div>
    </div>
  );
}

/**
 * T-elev: the surface steps and the overlay shadow.
 * @returns The specimen
 */
export function ElevationSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <ul class="steps">
        {['ground', 'surface', 'container', 'container-high'].map((s) => (
          <li key={s} class="elev-step" style={swatch(s)}>
            <span class="token-name">--{s}</span>
          </li>
        ))}
      </ul>
      <div class="overlay-demo">
        <span class="token-name">--shadow-overlay</span>
      </div>
    </div>
  );
}

const HEIGHTS = ['control-xs', 'control-sm', 'control-md', 'target-min'];

/**
 * T-target and T-size: control heights per density and the fixed geometry.
 * @returns The specimen
 */
export function SizeSpecimen(): JSX.Element {
  const fixed = TOKEN_NAMES.filter((t) =>
    /^--(size|icon-(sm|md|lg)|rail|popup-|page-|wide)/.test(t),
  );
  return (
    <div class="stack">
      <div class="densities">
        {(['popup', 'desktop'] as const).map((d) => (
          <div key={d} data-density={d} class="density">
            <h3 class="label">{d} density</h3>
            <ul class="heights">
              {HEIGHTS.map((h) => (
                <li key={h} class="height" style={{ '--h': `var(--${h})` }}>
                  <span class="token-name">--{h}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <h3 class="label">Fixed geometry</h3>
      <ul class="bars">
        {fixed.map((t) => (
          <li key={t} class="bar-row">
            <span class="token-name">{t}</span>
            <span class="bar" style={{ '--bar': `var(${t})` }} />
          </li>
        ))}
      </ul>
    </div>
  );
}

const DURATIONS = ['dur-fast', 'dur-effects', 'dur-spatial', 'dur-step'];
const EASES = ['ease-effects', 'ease-spatial'];

/**
 * T-motion: durations and easings, with a hover and focus demo.
 * @returns The specimen
 */
export function MotionSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <ul class="plain-list">
        {[...DURATIONS, ...EASES].map((t) => (
          <li key={t}>
            <span class="token-name">--{t}</span>{' '}
            <span class="token-value">
              {getComputedStyle(document.documentElement).getPropertyValue(`--${t}`).trim()}
            </span>
          </li>
        ))}
      </ul>
      <Cluster>
        {EASES.map((e) => (
          <button
            key={e}
            type="button"
            class="motion-demo"
            style={{ '--demo-ease': `var(--${e})` }}
          >
            Hover or focus: --{e}
          </button>
        ))}
      </Cluster>
    </div>
  );
}

/**
 * T-focus: the ring on the ground and on a card.
 * @returns The specimen
 */
export function FocusSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <Cluster>
        <span class="ring-demo">On the ground</span>
        <span class="ring-card">
          <span class="ring-demo">On a card (--ring-gap: --surface)</span>
        </span>
      </Cluster>
      <button type="button" class="focus-target">
        Tab here to see the real ring
      </button>
    </div>
  );
}

/**
 * A-icon: the glyph inventory at three sizes.
 * @returns The specimen
 */
export function IconSpecimen(): JSX.Element {
  return (
    <ul class="glyphs">
      {GLYPH_NAMES.map((g) => (
        <li key={g} class="glyph">
          <span class="glyph-sizes">
            <Icon glyph={g} />
            <Icon glyph={g} size="md" />
            <Icon glyph={g} size="lg" />
          </span>
          <span class="token-name">{g}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * F-utils: .num, .mono and .visually-hidden.
 * @returns The specimen
 */
export function UtilitiesSpecimen(): JSX.Element {
  return (
    <div class="stack">
      <ul class="plain-list">
        {[7, 42, 100].map((v) => (
          <li key={v}>
            Volume{' '}
            <span class="num" style={{ '--num-ch': 3 }}>
              {v}
            </span>
          </li>
        ))}
      </ul>
      <p class="narrow">
        <span class="mono">http://192.168.100.200:49400/stream/0f9e1c2a/live.flac</span>
      </p>
      <p>
        There is a sentence here for screen readers only:
        <span class="visually-hidden"> this one.</span>
      </p>
    </div>
  );
}

/**
 * F-utils: Cluster's gaps, justify and stack.
 * @returns The specimen
 */
export function ClusterSpecimen(): JSX.Element {
  const items = ['Kitchen', 'Study', 'Garden', 'Landing'];
  const pills = items.map((i) => (
    <span key={i} class="pill">
      {i}
    </span>
  ));
  return (
    <div class="stack">
      {(['2', '3', '4'] as const).map((g) => (
        <div key={g}>
          <h3 class="label">gap {g}</h3>
          <Cluster gap={g}>{pills}</Cluster>
        </div>
      ))}
      <h3 class="label">justify between</h3>
      <Cluster justify="between">{pills.slice(0, 2)}</Cluster>
      <h3 class="label">stack (under a 25rem cluster the items stack full width)</h3>
      <div class="narrow">
        <Cluster stack>
          <span class="pill">Cancel</span>
          <span class="pill">Stop all casts</span>
        </Cluster>
      </div>
    </div>
  );
}

/**
 * A-announcer: say a polite message, an urgent one, and a keyed one.
 * @returns The specimen
 */
export function AnnouncerSpecimen(): JSX.Element {
  const { say } = useAnnouncer();
  const [count, setCount] = useState(0);
  return (
    <div class="stack">
      <p>
        With a screen reader on, each button speaks once through the page&apos;s one
        AnnouncerProvider. The keyed message is only ever said once.
      </p>
      <Cluster>
        <button type="button" class="demo-button" onClick={() => say('Copied')}>
          Say “Copied”
        </button>
        <button
          type="button"
          class="demo-button"
          onClick={() => say('Kitchen did not join. Try again.', { urgent: true })}
        >
          Say urgently
        </button>
        <button
          type="button"
          class="demo-button"
          onClick={() => {
            setCount(count + 1);
            say('The companion answered.', { key: 'catalogue-demo' });
          }}
        >
          Say once (pressed <span class="num">{count}</span>)
        </button>
      </Cluster>
    </div>
  );
}
