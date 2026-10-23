import type { JSX } from 'preact';
import { Fragment, type RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Clacks } from '../Clacks';
import { Icon } from '../Icon';
import type { GlyphName } from '../Icon/glyphs';
import { useAnnouncer } from '../Announcer';
import { cx, dataAttributes, type DataAttributes } from '../utils/cx';
import { usePress } from '../utils/press';
import { labelFor, useAction, type ActionLabels, type ActionStatus } from './action';
import { IN_START, OUT_END, anchorOf, heldAt, inlineSpan, parseTime } from './morph';
import styles from './Button.module.css';

/** Props for {@link Button}. */
export interface ButtonProps extends DataAttributes {
  /**
   * The kind (DESIGN.md A-button). filled: the one main action of a view (Cast, Carry on);
   * tonal: the default; outline: Cancel and notice actions; quiet: Add a room, the sets;
   * link: a stand-alone link (Update available).
   */
  kind?: 'filled' | 'tonal' | 'outline' | 'quiet' | 'link';
  /** Filled or tonal only. Tonal danger with the `stop` glyph is Stop; filled is Stop all. */
  danger?: boolean;
  /**
   * sm (the default) is 32 on every surface. md is the prominent size (36 in the popup, 44
   * in a window), only for the action a view, step, bar or dialog exists for (F-size).
   */
  size?: 'sm' | 'md';
  /** A glyph in the start slot. */
  icon?: GlyphName;
  /** A short trailing word or count, such as "3 rooms". */
  trail?: string;
  /**
   * A toggle that stays down (the sets): `aria-pressed`, calm, with a trailing check. Its
   * check slot is always kept, so turning it on or off never changes the width.
   */
  pressed?: boolean;
  /** A disclosure trigger: a trailing chevron and `aria-expanded`. */
  expanded?: boolean;
  /** A second line under the label. */
  description?: string;
  /** Where the content sits: centred, or at the start (full-width list buttons). */
  align?: 'center' | 'start';
  /** Fill the container's inline size. */
  fullWidth?: boolean;
  /**
   * Pull back by the leading padding, so the glyph or the first letter lines up with the
   * text column above (a quiet Button that starts a column: Details, Skip, Copy URL).
   */
  flush?: boolean;
  /** An async action: busy, then done or failed, said through the Announcer. */
  onAction?: () => Promise<unknown>;
  /**
   * A plain click handler, for actions with no async result. It runs before `onAction`, and
   * calling `event.preventDefault()` in it stops the action (a field that is not valid yet).
   */
  onClick?: (event: MouseEvent) => void;
  /**
   * A result held from outside, for an action with no busy step (CopyField's `done`): it
   * shows the result's label and glyph until it changes. Without it the Button keeps its own.
   */
  status?: 'idle' | 'done';
  /** The words for busy, done and failed. */
  labels?: ActionLabels;
  /** Done and failed return to idle when this changes; there are no timers. */
  resetKey?: unknown;
  /**
   * A destination: renders an `<a>` drawn as the kind (the link kind, or a tonal "Back to
   * Rooms"). Pressed by Enter alone, as a link is.
   */
  href?: string;
  /** Where the link opens, with `href`. */
  target?: '_blank';
  /** Disabled: 38 % ink, a 12 % fill, and the rest shape. */
  disabled?: boolean;
  /** The form role. Defaults to "button". */
  type?: 'button' | 'submit';
  /** An accessible name that starts with the visible words, for context (WCAG 2.5.3). */
  'aria-label'?: string;
  /** Ties a hint or a notice to the Button. */
  'aria-describedby'?: string;
  /** What an `expanded` trigger opens: the panel's id, while it is open. */
  'aria-controls'?: string;
  /** The element id. */
  id?: string;
  /** The label: one string, which is also the accessible name. */
  children: string;
}

/**
 * The one text action (DESIGN.md A-button). It absorbs ActionButton (async states),
 * SetButton (`pressed`), the raw text buttons and the Alert's inline action. It fits what it
 * shows now (idle, busy, done or failed: a glyph and words); a change of state morphs its
 * width while the old words fade out and then the new ones fade in, never both at once.
 * Hover is colour; focus-visible and a press take the bevel, on every kind, and nothing scales.
 * @param props - Component props
 * @param props.kind - The kind
 * @param props.danger - Danger, on filled or tonal
 * @param props.size - sm or md
 * @param props.icon - The start glyph
 * @param props.trail - A trailing word or count
 * @param props.pressed - On, for a toggle
 * @param props.expanded - Open, for a disclosure trigger
 * @param props.description - A second line
 * @param props.align - Centre or start
 * @param props.fullWidth - Fill the container
 * @param props.flush - Line the glyph up with the text column above
 * @param props.onAction - An async action
 * @param props.onClick - A click handler, which can stop the action
 * @param props.status - A result held from outside
 * @param props.labels - Busy, done and failed words
 * @param props.resetKey - Returns done or failed to idle when it changes
 * @param props.href - Renders a link
 * @param props.target - Where the link opens
 * @param props.disabled - Disabled
 * @param props.type - The form role
 * @param props.id - The element id
 * @param props.children - The label
 * @returns The button, or a link
 */
export function Button({
  kind = 'tonal',
  danger = false,
  size = 'sm',
  icon,
  trail,
  pressed,
  expanded,
  description,
  align = 'center',
  fullWidth = false,
  flush = false,
  onAction,
  onClick,
  status: heldStatus,
  labels,
  resetKey,
  href,
  target,
  disabled = false,
  type = 'button',
  id,
  children,
  ...rest
}: ButtonProps): JSX.Element {
  const { say } = useAnnouncer();
  const { status: ownStatus, run } = useAction(onAction, { labels, resetKey, say });
  const status: ActionStatus = heldStatus === 'done' ? 'done' : ownStatus;
  const busy = status === 'busy';
  const isDanger = danger && (kind === 'filled' || kind === 'tonal');

  const handleClick = (event: MouseEvent): void => {
    if (busy || disabled) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
    if (onAction && !event.defaultPrevented) run();
  };

  // The Button fits what it shows now. A change of state morphs it (see useMorph): the box
  // eases to its new width, the words it leaves fade up and out where they were, and the
  // words it goes to fade in afterwards. Words that do not change stay; only the glyph fades.
  const words = labelFor(status, children, labels);
  const glyph = glyphKey(status, icon);
  const morph = useMorph(status, words, glyph);
  // A link is pressed by Enter alone; a button by Enter and Space.
  const isLink = Boolean(href);
  const press = usePress(isLink ? ['enter'] : undefined);
  const leaving = morph.leaving;

  const className = cx(
    styles.button,
    styles[kind],
    styles[size],
    isDanger && styles.danger,
    glyph && styles.withIcon,
    align === 'start' && styles.start,
    fullWidth && styles.full,
    flush && styles.flush,
    description && styles.twoLine,
  );

  const content = (
    <>
      <span class={styles.text}>
        <span class={styles.unit} ref={morph.unitRef}>
          {glyph && (
            <span class={styles.lead} ref={morph.leadRef}>
              {leaving?.glyphOnly && leaving.glyph && (
                <Fragment key={leaving.glyph}>{leadFor(leaving.glyph)}</Fragment>
              )}
              <Fragment key={glyph}>{leadFor(glyph)}</Fragment>
            </span>
          )}
          <span class={styles.label}>{words}</span>
        </span>
        {description && <span class={styles.description}>{description}</span>}
      </span>
      {leaving && !leaving.glyphOnly && (
        <span class={styles.ghost} aria-hidden="true">
          <span key={leaving.serial} class={styles.unit} ref={morph.ghostRef}>
            {leaving.glyph && <span class={styles.lead}>{leadFor(leaving.glyph)}</span>}
            <span class={styles.label}>{leaving.words}</span>
          </span>
        </span>
      )}
      {trail && <span class={cx(styles.trail, 'num')}>{trail}</span>}
      {pressed !== undefined && (
        <span class={styles.check} data-on={pressed ? '' : undefined}>
          <Icon glyph="check" />
        </span>
      )}
      {expanded !== undefined && (
        <span class={styles.chevron}>
          <Icon glyph="chevron-down" />
        </span>
      )}
    </>
  );

  const common = {
    id,
    class: className,
    'data-status': status === 'idle' ? undefined : status,
    'data-size': size,
    'data-tone': isDanger || status === 'failed' ? 'danger' : undefined,
    'aria-label': rest['aria-label'],
    'aria-describedby': rest['aria-describedby'],
    'aria-controls': rest['aria-controls'],
    'aria-busy': busy ? ('true' as const) : undefined,
    ...press,
    ...dataAttributes(rest),
  };

  if (isLink) {
    return (
      <a
        {...common}
        ref={morph.ref}
        href={disabled ? undefined : href}
        target={target}
        rel={target === '_blank' ? 'noreferrer' : undefined}
        aria-disabled={disabled ? 'true' : undefined}
        onClick={handleClick}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      {...common}
      ref={morph.ref}
      type={type}
      disabled={disabled}
      aria-disabled={busy ? 'true' : undefined}
      aria-pressed={pressed === undefined ? undefined : pressed}
      aria-expanded={expanded === undefined ? undefined : expanded}
      onClick={handleClick}
    >
      {content}
    </button>
  );
}

/** What the start slot can hold: the idle glyph, the Clacks, the check or the danger glyph. */
type GlyphKey = GlyphName | 'clacks';

/**
 * What the start slot holds for a status: the Clacks while busy, the check when done, the
 * danger glyph when failed, else the idle icon.
 * @param status - The action status
 * @param icon - The idle icon
 * @returns The slot's content, or undefined for none
 */
function glyphKey(status: ActionStatus, icon: GlyphName | undefined): GlyphKey | undefined {
  if (status === 'busy') return 'clacks';
  if (status === 'done') return 'check';
  if (status === 'failed') return 'danger';
  return icon;
}

/**
 * Draws a start-slot glyph.
 * @param key - The glyph
 * @returns The Clacks or the icon
 */
function leadFor(key: GlyphKey): JSX.Element {
  return key === 'clacks' ? <Clacks size="sm" /> : <Icon glyph={key} />;
}

/** The words and glyph a Button is leaving, drawn while they fade. */
interface Leaving {
  /** Counts the changes, so each one draws fresh. */
  serial: number;
  /** The words it leaves. */
  words: string;
  /** The glyph it leaves. */
  glyph: GlyphKey | undefined;
  /** The words stay the same, so only the glyph fades. */
  glyphOnly: boolean;
}

/** The Button as it was just before a change: measured live, so mid-change counts. */
interface Before {
  /** The Button's border box. */
  box: DOMRect;
  /** Its start padding. */
  pad: string;
  /** The words and glyph. */
  unit: DOMRect;
  /** How visible the words were (less than 1 if they were still fading in). */
  opacity: number;
  /** `--dur-change` in ms. */
  ms: number;
  /** `--ease-effects`. */
  ease: string;
}

/**
 * Measures a Button just before a change, as it is on screen.
 * @param ref - The Button
 * @param unitRef - Its words and glyph
 * @returns The measurements, or null when the change should be instant: `--dur-change` is 0
 *   (reduced motion), there is no `animate`, or the Button is not laid out
 */
function measure(ref: RefObject<HTMLElement>, unitRef: RefObject<HTMLElement>): Before | null {
  const el = ref.current;
  const unit = unitRef.current;
  if (!el || !unit || typeof el.animate !== 'function') return null;
  // The unit's opacity transition is --dur-change and --ease-effects, resolved by the engine
  // (a calc, a var or 0s under reduced motion all come back as a plain time).
  const timing = getComputedStyle(unit);
  const ms = parseTime(timing.transitionDuration);
  const box = el.getBoundingClientRect();
  if (!ms || box.width === 0) return null;
  return {
    box,
    pad: getComputedStyle(el).paddingInlineStart,
    unit: unit.getBoundingClientRect(),
    opacity: Number(timing.opacity) || 0,
    ms,
    ease: timing.transitionTimingFunction || 'ease',
  };
}

/**
 * A Button's change of state (DESIGN.md A-button). The Button fits what it shows. When the
 * status changes it measures the Button (live, so an interrupted change starts where it is),
 * renders the new state, measures again and eases `inline-size` and `padding-inline-start`
 * from the old values to the new over `--dur-change` with `--ease-effects`. The layout
 * decides which edge moves; neighbours ease with it because it is layout.
 *
 * The words never overlap: the words it leaves fade out with a `--space-1` rise over the
 * first 0.4 of the change, held to the edge that stays and clipped to the box; the words it
 * goes to fade in from `--space-1` below over the second half, centred and clipped. If the
 * words stay the same, they do not move and only the glyph fades. With `--dur-change` at 0
 * (reduced motion), or without `animate`, the change is instant.
 * @param status - The status shown now
 * @param words - The words shown now
 * @param glyph - The glyph shown now
 * @returns The refs to attach, and what is leaving, if anything
 */
function useMorph(
  status: ActionStatus,
  words: string,
  glyph: GlyphKey | undefined,
): {
  ref: RefObject<HTMLButtonElement & HTMLAnchorElement>;
  unitRef: RefObject<HTMLSpanElement>;
  leadRef: RefObject<HTMLSpanElement>;
  ghostRef: RefObject<HTMLSpanElement>;
  leaving: Leaving | null;
} {
  const ref = useRef<HTMLButtonElement & HTMLAnchorElement>(null);
  const unitRef = useRef<HTMLSpanElement>(null);
  const leadRef = useRef<HTMLSpanElement>(null);
  const ghostRef = useRef<HTMLSpanElement>(null);
  const running = useRef<Animation[]>([]);
  const before = useRef<Before | null>(null);
  const seen = useRef<{ status: ActionStatus; leaving: Leaving | null }>({
    status,
    leaving: null,
  });
  const [gone, setGone] = useState(0);
  const count = useRef(0);
  const shown = useRef({ words, glyph });

  // Read the Button as it is on screen before the DOM changes: this render is the change.
  if (seen.current.status !== status) {
    const was = shown.current;
    before.current = was.words === words && was.glyph === glyph ? null : measure(ref, unitRef);
    count.current += 1;
    seen.current = {
      status,
      leaving: before.current
        ? {
            serial: count.current,
            words: was.words,
            glyph: was.glyph,
            glyphOnly: was.words === words,
          }
        : null,
    };
  }
  shown.current = { words, glyph };
  const leaving =
    seen.current.leaving && seen.current.leaving.serial !== gone ? seen.current.leaving : null;

  useLayoutEffect(() => {
    const from = before.current;
    before.current = null;
    const el = ref.current;
    const unit = unitRef.current;
    for (const a of running.current) a.cancel();
    running.current = [];
    el?.removeAttribute('data-morph');
    if (!from || !el || !unit || !seen.current.leaving) return;
    const serial = seen.current.leaving.serial;
    const leftBehind = seen.current.leaving;
    try {
      animateChange(el, unit, from, leftBehind, glyph, running.current, () => setGone(serial), {
        lead: leadRef.current,
        ghost: ghostRef.current,
      });
    } catch {
      // A change that cannot animate is instant; it never breaks the Button.
      for (const a of running.current) a.cancel();
      running.current = [];
      el.removeAttribute('data-morph');
      setGone(serial);
    }
  }, [seen.current.leaving?.serial]);

  useEffect(
    () => () => {
      for (const a of running.current) a.cancel();
    },
    [],
  );

  return { ref, unitRef, leadRef, ghostRef, leaving };
}

/**
 * Runs one change of state's animations (see {@link useMorph}): the box, then the words or
 * the glyph. Every animation it starts goes into `running`, so the next change can cancel it.
 * @param el - The Button, already showing the new state
 * @param unit - Its words and glyph now
 * @param from - The Button just before the change
 * @param leaving - What it leaves
 * @param glyph - The glyph it shows now
 * @param running - Collects the animations
 * @param gone - Called when what it leaves has faded out
 * @param parts - The start slot and the leaving words, where drawn
 * @param parts.lead - The start slot
 * @param parts.ghost - The leaving words
 */
function animateChange(
  el: HTMLElement,
  unit: HTMLElement,
  from: Before,
  leaving: Leaving,
  glyph: GlyphKey | undefined,
  running: Animation[],
  gone: () => void,
  { lead, ghost }: { lead: HTMLElement | null; ghost: HTMLElement | null },
): void {
  const style = getComputedStyle(el);
  const rise = style.getPropertyValue('--space-1').trim() || '0';
  const { ms, ease } = from;
  const to = el.getBoundingClientRect();
  const pad = style.paddingInlineStart;
  const run = (target: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
    const a = target.animate(keyframes, { easing: ease, ...options });
    running.push(a);
    return a;
  };

  // The box: from its old width and start padding to its new ones.
  if (Math.abs(to.width - from.box.width) >= 0.5 || pad !== from.pad) {
    el.setAttribute('data-morph', '');
    const box = run(
      el,
      [
        { inlineSize: `${from.box.width}px`, paddingInlineStart: from.pad },
        { inlineSize: `${to.width}px`, paddingInlineStart: pad },
      ],
      { duration: ms },
    );
    box.onfinish = () => el.removeAttribute('data-morph');
  }

  const outro = { duration: ms * OUT_END, fill: 'forwards' as const };
  const intro = {
    duration: ms * (1 - IN_START),
    delay: ms * IN_START,
    fill: 'backwards' as const,
  };
  const done = (a: Animation): void => {
    a.onfinish = gone;
  };

  if (leaving.glyphOnly) {
    // The words stay; the old glyph fades out in the slot and the new one fades in.
    const kids = lead ? [...lead.children] : [];
    const old = leaving.glyph && kids.length > 1 ? kids[0] : null;
    const now = glyph ? kids.at(-1) : null;
    if (old) done(run(old, [{ opacity: 1 }, { opacity: 0 }], outro));
    if (now) run(now, [{ opacity: 0 }, { opacity: 1 }], intro);
    return;
  }

  // The words it leaves: held where they were, from the edge that stays.
  if (ghost) {
    const rtl = style.direction === 'rtl';
    const box = inlineSpan(from.box.left, from.box.right, rtl);
    const border = {
      start: parseFloat(style.borderInlineStartWidth) || 0,
      end: parseFloat(style.borderInlineEndWidth) || 0,
    };
    const anchor = anchorOf(box, inlineSpan(to.left, to.right, rtl));
    ghost.style.insetInlineStart = heldAt(
      anchor,
      box,
      inlineSpan(from.unit.left, from.unit.right, rtl),
      border,
    );
    ghost.style.insetBlockStart = `${from.unit.top - from.box.top - (parseFloat(style.borderBlockStartWidth) || 0)}px`;
    done(
      run(
        ghost,
        [
          { opacity: from.opacity, translate: '0 0' },
          { opacity: 0, translate: `0 calc(-1 * ${rise})` },
        ],
        outro,
      ),
    );
  }
  // The words it goes to: from below, once the old ones have gone.
  run(
    unit,
    [
      { opacity: 0, translate: `0 ${rise}` },
      { opacity: 1, translate: '0 0' },
    ],
    intro,
  );
}
