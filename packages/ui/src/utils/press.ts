import { useEffect } from 'preact/hooks';
import { parseTime } from '../Button/morph';

/**
 * The press hold (DESIGN.md T-state, "Shape per state"). A press morphs a control to the
 * bevel over --dur-shape, but `:active` lasts only as long as the press: a quick tap or click
 * (about 80 ms) let go before the corner had moved, and Enter never sets `:active` at all.
 * So a press sets `data-pressing` on the control and keeps it until the later of the release
 * and --dur-shape after the press began; the styles read it beside `:active`. Under reduced
 * motion --dur-shape is 0, so the hold ends with the release (once a frame has drawn it) and
 * the shape swaps at once.
 *
 * One set of listeners on the document serves every pressable control: a control marks its
 * root with `data-press` (the keys that press it), and the listeners are added while at least
 * one such control is mounted. Nothing here reads or changes layout.
 */

/** The keys that press a control, as `data-press` lists them. */
export type PressKey = 'enter' | 'space';

/** The props a pressable control spreads on its root. */
export interface PressProps {
  /** The keys that press it: `enter space`, `enter` (a link) or `space` (a checkbox, a radio). */
  'data-press': string;
}

/** The attribute the styles read while a press is held. */
export const PRESSING = 'data-pressing';

/** A press in progress or being held to the end of the morph. */
interface Hold {
  /** When the morph began: the first frame drawn with the press, on the frame clock. */
  start: number;
  /** What pressed it: a pointer, or the key (released by its own keyup). */
  by: 'pointer' | PressKey;
  /** Whether it has been let go of. */
  released: boolean;
  /** A pending timer, if any. */
  timer?: ReturnType<typeof setTimeout>;
  /** A pending frame, if any. */
  frame?: number;
}

const holds = new Map<HTMLElement, Hold>();
let users = 0;

/**
 * Names the key an event carries, if it is one that presses.
 * @param event - The key event
 * @returns The key, or null for any other
 */
function keyOf(event: KeyboardEvent): PressKey | null {
  if (event.key === 'Enter') return 'enter';
  if (event.key === ' ') return 'space';
  return null;
}

/**
 * Finds the pressable control an event is in, if it takes a press now.
 * @param target - The event's target
 * @returns The control, or null when there is none or it is disabled or busy
 */
function pressable(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  // A label forwards its press to its control (the Switch's words press the track).
  const el =
    target.closest<HTMLElement>('[data-press]') ??
    target.closest('label')?.control?.closest<HTMLElement>('[data-press]');
  if (!el) return null;
  // Disabled, or busy (which sets aria-disabled): a press does nothing, so it shows nothing.
  if (el.matches(':disabled, [aria-disabled="true"]') || el.querySelector(':disabled')) {
    return null;
  }
  return el;
}

/**
 * Cancels a hold's pending timer and frame.
 * @param hold - The hold
 */
function cancel(hold: Hold | undefined): void {
  if (hold?.timer !== undefined) clearTimeout(hold.timer);
  if (hold?.frame !== undefined) cancelAnimationFrame(hold.frame);
}

/**
 * Ends a hold now.
 * @param el - The control
 */
function drop(el: HTMLElement): void {
  cancel(holds.get(el));
  holds.delete(el);
  el.removeAttribute(PRESSING);
}

/**
 * Starts a hold, or restarts one still running out after an earlier press.
 * @param el - The control
 * @param by - What pressed it
 */
function press(el: HTMLElement, by: Hold['by']): void {
  cancel(holds.get(el));
  const hold: Hold = { start: performance.now(), by, released: false };
  holds.set(el, hold);
  el.setAttribute(PRESSING, '');
  // The transition starts with the first frame drawn after this, so the morph is timed from it.
  hold.frame = requestAnimationFrame((time) => {
    hold.start = time;
    hold.frame = undefined;
  });
}

/**
 * Ends a released hold once the morph has had --dur-shape: it waits out the time left, lets
 * one frame draw the finished bevel, and drops the hold before the next.
 * @param el - The control
 * @param hold - Its hold
 * @param duration - --dur-shape, in ms
 */
function finish(el: HTMLElement, hold: Hold, duration: number): void {
  const left = hold.start + duration - performance.now();
  if (left > 0 || hold.frame !== undefined) {
    hold.timer = setTimeout(() => finish(el, hold, duration), Math.max(left, 0));
    return;
  }
  hold.timer = undefined;
  hold.frame = requestAnimationFrame(() => {
    hold.frame = requestAnimationFrame(() => drop(el));
  });
}

/**
 * Lets go of a press: the hold ends once the morph has run, and at once after a press long
 * enough to have finished it. Under reduced motion (--dur-shape 0) it ends with the release,
 * but never before one frame has drawn the press, so a tap that lands within a frame still
 * shows its bevel and layer.
 * @param el - The control
 */
function release(el: HTMLElement): void {
  const hold = holds.get(el);
  if (!hold || hold.released) return;
  hold.released = true;
  const duration = parseTime(getComputedStyle(el).getPropertyValue('--dur-shape'));
  if (hold.frame === undefined && performance.now() - hold.start >= duration) {
    drop(el);
    return;
  }
  finish(el, hold, duration);
}

/**
 * Lets go of every press made a given way.
 * @param by - The way: a pointer, or a key
 */
function releaseBy(by: Hold['by']): void {
  for (const [el, hold] of holds) if (hold.by === by) release(el);
}

const onPointerDown = (event: PointerEvent): void => {
  if (!event.isPrimary || event.button !== 0) return;
  const el = pressable(event.target);
  if (el) press(el, 'pointer');
};

const onPointerUp = (): void => releaseBy('pointer');

/* A cancelled pointer (a touch that became a scroll) was never a press: no hold. */
const onPointerCancel = (): void => {
  for (const [el, hold] of holds) if (hold.by === 'pointer') drop(el);
};

const onKeyDown = (event: KeyboardEvent): void => {
  const key = keyOf(event);
  if (!key || event.repeat) return;
  const el = pressable(event.target);
  if (el?.dataset.press?.split(' ').includes(key)) press(el, key);
};

const onKeyUp = (event: KeyboardEvent): void => {
  const key = keyOf(event);
  if (key) releaseBy(key);
};

/* Leaving the window mid-press never delivers the release, so it ends the press. */
const onBlur = (): void => {
  for (const el of holds.keys()) release(el);
};

const LISTENERS = [
  ['pointerdown', onPointerDown],
  ['pointerup', onPointerUp],
  ['pointercancel', onPointerCancel],
  ['keydown', onKeyDown],
  ['keyup', onKeyUp],
] as const;

/** Adds the document's listeners for the first pressable control. */
function attach(): void {
  for (const [type, listener] of LISTENERS) {
    document.addEventListener(type, listener as EventListener, true);
  }
  window.addEventListener('blur', onBlur);
}

/** Removes them, and every hold, when the last one goes. */
function detach(): void {
  for (const [type, listener] of LISTENERS) {
    document.removeEventListener(type, listener as EventListener, true);
  }
  window.removeEventListener('blur', onBlur);
  for (const el of [...holds.keys()]) drop(el);
}

/**
 * Makes a control show its press for at least the length of the shape's morph, from a
 * pointer (mouse, touch, pen) or the keys given. Spread the result on the control's root;
 * its styles read `[data-pressing]` beside `:active`. Disabled and busy controls are skipped.
 * @param keys - The keys that press the control: Enter and Space for a button, Enter alone
 *   for a link, Space alone for a checkbox or a radio
 * @returns The props for the control's root
 */
export function usePress(keys: readonly PressKey[] = ['enter', 'space']): PressProps {
  useEffect(() => {
    if (users++ === 0) attach();
    return () => {
      if (--users === 0) detach();
    };
  }, []);
  return { 'data-press': keys.join(' ') };
}
