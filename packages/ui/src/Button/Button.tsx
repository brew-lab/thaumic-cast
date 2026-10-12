import type { JSX } from 'preact';
import { Clacks } from '../Clacks';
import { Icon } from '../Icon';
import type { GlyphName } from '../Icon/glyphs';
import { useAnnouncer } from '../Announcer';
import { cx, dataAttributes, type DataAttributes } from '../utils/cx';
import { labelFor, useAction, type ActionLabels, type ActionStatus } from './action';
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
  /** A short trailing word or count, such as "Saved" or "3". */
  trail?: string;
  /** A toggle that stays down (the sets): `aria-pressed`, calm, with a trailing check. */
  pressed?: boolean;
  /** A disclosure trigger: a trailing chevron and `aria-expanded`. */
  expanded?: boolean;
  /** A second line under the label. */
  description?: string;
  /** Where the content sits: centred, or at the start (full-width list buttons). */
  align?: 'center' | 'start';
  /** Fill the container's inline size. */
  fullWidth?: boolean;
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
  /** The link kind's destination: renders an `<a>`. */
  href?: string;
  /** Where the link opens, for the link kind with `href`. */
  target?: '_blank';
  /** Disabled: 38 % ink, a 12 % fill, and the rest shape. */
  disabled?: boolean;
  /** The form role. Defaults to "button". */
  type?: 'button' | 'submit';
  /** An accessible name that starts with the visible words, for context (WCAG 2.5.3). */
  'aria-label'?: string;
  /** Ties a hint or a notice to the Button. */
  'aria-describedby'?: string;
  /** The element id. */
  id?: string;
  /** The label: one string, which is also the accessible name. */
  children: string;
}

/**
 * The one text action (DESIGN.md A-button). It absorbs ActionButton (async states),
 * SetButton (`pressed`), the raw text buttons and the Alert's inline action. Every label it
 * can show sits in one grid cell, so its width never jumps. Shapes appear only on hover,
 * focus and press, and a danger Button never reshapes.
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

  const lead = leadFor(status, icon);
  const words = [children, labels?.busy, labels?.done, labels?.failed].filter(
    (w, i, all): w is string => !!w && all.indexOf(w) === i,
  );
  const current = labelFor(status, children, labels);

  const className = cx(
    styles.button,
    styles[kind],
    styles[size],
    isDanger && styles.danger,
    align === 'start' && styles.start,
    fullWidth && styles.full,
    description && styles.twoLine,
  );

  const content = (
    <>
      {lead && <span class={styles.lead}>{lead}</span>}
      <span class={styles.text}>
        <span class={styles.labels}>
          {words.map((w) => (
            <span
              key={w}
              class={styles.label}
              data-current={w === current ? '' : undefined}
              aria-hidden={w === current ? undefined : 'true'}
            >
              {w}
            </span>
          ))}
        </span>
        {description && <span class={styles.description}>{description}</span>}
      </span>
      {trail && <span class={cx(styles.trail, 'num')}>{trail}</span>}
      {pressed && (
        <span class={styles.check}>
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
    'aria-label': rest['aria-label'],
    'aria-describedby': rest['aria-describedby'],
    'aria-busy': busy ? ('true' as const) : undefined,
    ...dataAttributes(rest),
  };

  if (kind === 'link' && href) {
    return (
      <a
        {...common}
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

/**
 * What the start slot holds: the Clacks while busy, the check when done, the danger glyph
 * when failed, else the icon.
 * @param status - The action status
 * @param icon - The idle icon
 * @returns The slot's content, or null for none
 */
function leadFor(status: ActionStatus, icon: GlyphName | undefined): JSX.Element | null {
  if (status === 'busy') return <Clacks size="sm" />;
  if (status === 'done') return <Icon glyph="check" />;
  if (status === 'failed') return <Icon glyph="danger" />;
  return icon ? <Icon glyph={icon} /> : null;
}
