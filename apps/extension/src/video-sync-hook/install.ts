/**
 * The audio-lead hook's runtime: patches Media Source Extensions in the
 * page's MAIN world so the page's audio plays `lead` seconds of wall time
 * earlier than its picture.
 *
 * It rewrites the native timestampOffset and append window of the page's
 * audio SourceBuffers while presenting the player with the values it set
 * (virtual values) for timestampOffset, appendWindowStart/End, mode,
 * buffered and remove(). Per shifted SourceBuffer:
 *   off            native time minus virtual time (-lead x rate, 0 when idle)
 *   native TO      = virtual TO + off
 *   native window  = virtual window + off (start clamped at 0)
 *   virtual ranges = native ranges - off
 * A change of `off` is an immediate switch (see plan.ts): remove native
 * audio from a cut just ahead of the playhead and append the cached
 * fragments again under the new offset, with every event of those
 * operations hidden from the player and the player's own calls queued
 * meanwhile as if the buffer were busy.
 *
 * Video is never shifted or cached. Safety checks (guards.ts) turn the lead
 * off for a MediaSource rather than seek: the hook never writes currentTime.
 *
 * Ported from the field-tested video sync lab hook (0.3.4), audio-earlier
 * path only.
 */

import {
  addEntry,
  createCache,
  evict,
  forgetRange,
  type AudioCache,
  type CacheEntry,
  type InitRef,
} from './cache';
import {
  DeadMan,
  freezeVerdict,
  isLive,
  liveTooClose,
  nextStarve,
  starved,
  trackLiveEdge,
  type FreezeState,
  type LiveEdgeState,
} from './guards';
import { classify, formatOf, type BufferFormat, type BufferKind } from './mime';
import { planSwitch, rescaleRate, targetOffset, type Range } from './plan';
import { MAX_LEAD_MS, type HookStatus } from './protocol';
import { elementRanges, virtualRanges } from './ranges';
import { SegmentWalker } from './walker';

/** A deferral older than this is reported as `no-rap`, in ms. */
const NO_RAP_AFTER_MS = 10000;
/** Housekeeping period, in ms. */
const TICK_MS = 250;

/** Why a MediaSource's lead was turned off. */
type LatchReason = 'freeze' | 'live-edge';
/** Why a buffer can never be shifted. */
type UnavailableReason = 'muxed' | 'format';

/** A pending internal SourceBuffer operation. */
interface OpWait {
  resolve: () => void;
  reject: (e: Error) => void;
  err: string | null;
  started: boolean;
}

/** One managed SourceBuffer. */
interface Rec {
  sb: SourceBuffer;
  ms: MediaSource;
  kind: BufferKind;
  fmt: BufferFormat;
  /** What the player set. */
  v: { to: number; aws: number; awe: number; mode: AppendMode };
  off: number;
  rateApplied: number;
  /** A switch is running: player calls are queued. */
  internal: boolean;
  queue: (() => void)[];
  /** Reported to the player as `updating` while queued or faked. */
  pendingAsync: boolean;
  opWait: OpWait | null;
  /** The init segment the player appended last. */
  currentInit: InitRef | null;
  /** The init segment the native parser last saw. */
  nativeInit: InitRef | null;
  cache: AudioCache | null;
  walker: SegmentWalker | null;
  unavailable: UnavailableReason | null;
  everShifted: boolean;
  /** Virtual ranges shown to the player while a switch runs. */
  bufSnap: [number, number][] | null;
  /** Frame duration (MP4 audio), 0 when unknown. */
  fd: number;
  deferUntil: number;
  deferSince: number;
  deferKey: string | null;
}

/** What the hook keeps per MediaSource. */
interface MsInfo {
  el: HTMLMediaElement | null;
  recs: Set<Rec>;
  /** Events our own operations will cause, to hide from the player. */
  expect: { sourceopen: number; sourceended: number };
  fakeEnded: boolean;
  /** endOfStream / duration calls held until a switch ends. */
  deferred: (() => void)[];
  latched: LatchReason | null;
  liveEdge: LiveEdgeState | null;
  starve: number;
}

/**
 * The hook's control surface, used by the MAIN-world half of the bridge.
 */
export interface HookController {
  /**
   * Sets the wanted lead. Also feeds the dead-man switch.
   * @param enabled - Whether a lead is wanted
   * @param leadMs - Lead in ms of wall time
   */
  setLead(enabled: boolean, leadMs: number): void;
  /** Clears every "turned off" latch. Also feeds the dead-man switch. */
  rearm(): void;
  /**
   * Computes the frame's status now.
   * @returns The status
   */
  status(): HookStatus;
  /**
   * Registers the function that receives status changes.
   * @param fn - Called with each new status
   */
  onStatus(fn: (s: HookStatus) => void): void;
}

/** A function as stored in the masking table. */
type AnyFn = (...args: never[]) => unknown;

/**
 * Installs the hook on a window. Call once per realm, at document_start.
 * @param G - The page's window
 * @returns The controller
 */
export function installHook(G: Window & typeof globalThis): HookController {
  const hasMSE = typeof G.MediaSource === 'function' && typeof G.SourceBuffer === 'function';
  const nAEL = G.EventTarget.prototype.addEventListener;
  const nDispatch = G.EventTarget.prototype.dispatchEvent;
  const now = (): number => G.performance.now();

  // ---------------------------------------------------------- toString masking
  const masked = new WeakMap<object, string>();
  const nToString = G.Function.prototype.toString;
  /**
   * Makes a patched function print like a native one.
   * @param fn - The function
   * @param name - The native name to show
   * @returns The same function
   */
  function mask<T extends AnyFn>(fn: T, name: string): T {
    masked.set(fn, `function ${name}() { [native code] }`);
    return fn;
  }
  try {
    const toString = mask(function toString(this: unknown): string {
      const m = typeof this === 'function' ? masked.get(this) : undefined;
      return m !== undefined ? m : (Reflect.apply(nToString, this, []) as string);
    }, 'toString');
    Object.defineProperty(G.Function.prototype, 'toString', {
      value: toString,
      writable: true,
      configurable: true,
    });
  } catch {
    // keep the native toString
  }

  // ---------------------------------------------------------- state
  const cmd = { enabled: false, leadS: 0, heard: false };
  const deadMan = new DeadMan();
  const recs = new Set<Rec>();
  const recOf = new WeakMap<SourceBuffer, Rec>();
  const msInfo = new WeakMap<MediaSource, MsInfo>();
  const liveSources = new Set<MediaSource>();
  const urlToMs = new Map<string, MediaSource>();
  const pendingBind = new WeakMap<MediaSource, HTMLMediaElement>();
  const handleEls = new Set<HTMLMediaElement>();
  const hooked = new WeakSet<HTMLMediaElement>();
  const freezeWatch = new Map<HTMLMediaElement, FreezeState>();
  let statusSink: ((s: HookStatus) => void) | null = null;
  let lastStatusKey = '';
  let statusTimer = 0;
  let ticker = 0;
  let tickCount = 0;

  // Native readers and actions, replaced once MSE is patched.
  let nat: (sb: SourceBuffer) => [number, number][] = () => [];
  let applyAll: () => void = () => {};
  let switchTick: () => void = () => {};
  /** Runs the live guard and freeze watchdog; set once MSE is patched. */
  let guardTick: () => void = () => {};
  let nativeDuration: (ms: MediaSource) => number = () => NaN;

  // ---------------------------------------------------------- element and playhead
  /**
   * Finds the element a record's MediaSource plays in.
   * @param r - The record
   * @returns The element, or null when it is not known
   */
  function elFor(r: Rec): HTMLMediaElement | null {
    const mi = msInfo.get(r.ms);
    if (mi?.el) return mi.el;
    if (!G.document) return null;
    for (const [url, ms] of urlToMs) {
      if (ms !== r.ms) continue;
      for (const node of G.document.querySelectorAll('video,audio')) {
        const el = node as HTMLMediaElement;
        if (
          el.src === url ||
          el.currentSrc === url ||
          [...el.querySelectorAll('source')].some((x) => x.src === url)
        ) {
          if (mi) mi.el = el;
          hookEl(el);
          return el;
        }
      }
    }
    return null;
  }

  /**
   * The playhead of a record's element.
   * @param r - The record
   * @returns currentTime, or null without an element
   */
  function ctFor(r: Rec): number | null {
    const el = elFor(r);
    return el ? el.currentTime : null;
  }

  /**
   * The playback rate of a record's element.
   * @param r - The record
   * @returns The rate, 1 without an element
   */
  function rateFor(r: Rec): number {
    const el = elFor(r);
    const pr = el ? el.playbackRate : 1;
    return pr > 0 ? pr : 1;
  }

  /**
   * Whether a record's audio is encrypted with a known frame grid.
   * @param r - The record
   * @returns True when shifts must be whole frames
   */
  function encAudio(r: Rec): boolean {
    return !!(r.currentInit?.encrypted && r.fd > 0);
  }

  /**
   * The offset a record should have now.
   * @param r - The record
   * @returns The offset in seconds
   */
  function targetOff(r: Rec): number {
    if (r.kind !== 'audio' || r.unavailable) return 0;
    if (msInfo.get(r.ms)?.latched) return 0;
    return targetOffset({
      active: cmd.enabled,
      leadS: cmd.leadS,
      rate: r.rateApplied,
      encrypted: encAudio(r),
      frameDur: r.fd,
    });
  }

  /**
   * Turns the lead off for a MediaSource until a new one or a rearm.
   * @param ms - The MediaSource
   * @param why - The reason reported
   */
  function latch(ms: MediaSource, why: LatchReason): void {
    const mi = msInfo.get(ms);
    if (!mi || mi.latched) return;
    mi.latched = why;
    G.setTimeout(applyAll, 0);
    postStatusSoon();
  }

  /**
   * Live-edge state of a record's element.
   * @param r - The record
   * @returns The element, whether it is live and the distance to the edge, or null
   */
  function liveInfo(r: Rec): { el: HTMLMediaElement; live: boolean; dist: number | null } | null {
    const mi = msInfo.get(r.ms);
    const el = elFor(r);
    if (!mi || !el) return null;
    const sk = el.seekable;
    const edge = sk.length ? sk.end(sk.length - 1) : null;
    mi.liveEdge = trackLiveEdge(mi.liveEdge, edge, now());
    const live = isLive(el.duration, nativeDuration(r.ms), mi.liveEdge.moving);
    return { el, live, dist: edge !== null ? edge - el.currentTime : null };
  }

  /**
   * Whether a live stream is too near its edge for a shift.
   * @param r - The record
   * @param shiftS - The shift in seconds of media time
   * @returns True when the lead must not apply
   */
  function liveTooCloseFor(r: Rec, shiftS: number): boolean {
    const li = liveInfo(r);
    return !!li && li.live && li.dist !== null && liveTooClose(li.dist, shiftS);
  }

  /**
   * Registers an element's events and remembers it.
   * @param el - The element
   */
  function hookEl(el: HTMLMediaElement): void {
    if (hooked.has(el)) return;
    hooked.add(el);
    nAEL.call(el, 'ratechange', () => applyAll());
    nAEL.call(el, 'seeked', () => applyAll());
    nAEL.call(el, 'play', () => postStatusSoon());
    nAEL.call(el, 'pause', () => postStatusSoon());
  }

  /**
   * Binds an element to a MediaSource.
   * @param ms - The MediaSource
   * @param el - The element playing it
   */
  function bindMs(ms: MediaSource, el: HTMLMediaElement): void {
    const mi = msInfo.get(ms);
    if (mi) mi.el = el;
    else pendingBind.set(ms, el);
    hookEl(el);
  }

  /**
   * Binds an element to the MediaSource behind an object URL, if any.
   * @param el - The element
   * @param u - The URL it was given
   */
  function bindEl(el: HTMLMediaElement, u: string): void {
    const ms = urlToMs.get(u);
    if (ms) bindMs(ms, el);
  }

  // ---------------------------------------------------------- status
  /**
   * Picks the frame's main audio record: one whose element plays, else one
   * with an element, else any.
   * @returns The record, or null
   */
  function primary(): Rec | null {
    let withEl: Rec | null = null;
    let any: Rec | null = null;
    for (const r of recs) {
      if (r.kind !== 'audio' && r.kind !== 'muxed') continue;
      any ??= r;
      const el = elFor(r);
      if (!el) continue;
      if (!el.paused && !el.ended) return r;
      withEl ??= r;
    }
    return withEl ?? any;
  }

  /**
   * Whether an element is playing.
   * @param el - The element
   * @returns True while it plays
   */
  function isPlaying(el: HTMLMediaElement | null): boolean {
    return !!el && !el.paused && !el.ended && el.readyState > 2;
  }

  /**
   * Computes the frame's status.
   * @returns The status
   */
  function computeStatus(): HookStatus {
    const r = primary();
    if (!r) {
      for (const el of handleEls) {
        if (el.isConnected)
          return {
            state: 'unavailable',
            reason: 'worker',
            appliedLeadMs: 0,
            playing: isPlaying(el),
          };
      }
      if (G.document) {
        for (const node of G.document.querySelectorAll('video,audio')) {
          const el = node as HTMLMediaElement;
          if (isPlaying(el))
            return { state: 'unavailable', reason: 'no-mse', appliedLeadMs: 0, playing: true };
        }
      }
      return { state: cmd.heard ? 'no-media' : 'idle', appliedLeadMs: 0, playing: false };
    }
    const el = elFor(r);
    const playing = isPlaying(el);
    const applied = Math.min(
      MAX_LEAD_MS,
      Math.max(0, Math.round((-r.off / (r.rateApplied || 1)) * 1000)),
    );
    if (r.unavailable)
      return { state: 'unavailable', reason: r.unavailable, appliedLeadMs: 0, playing };
    const mi = msInfo.get(r.ms);
    if (mi?.latched) return { state: 'off', reason: mi.latched, appliedLeadMs: applied, playing };
    if (r.internal) return { state: 'switching', appliedLeadMs: applied, playing };
    const want = targetOff(r);
    if (Math.abs(want - r.off) >= 1e-6) {
      const stuck = r.deferSince && now() - r.deferSince > NO_RAP_AFTER_MS;
      return stuck
        ? { state: 'pending', reason: 'no-rap', appliedLeadMs: applied, playing }
        : { state: 'pending', appliedLeadMs: applied, playing };
    }
    if (cmd.enabled && cmd.leadS > 0) return { state: 'applied', appliedLeadMs: applied, playing };
    return { state: cmd.heard ? 'ready' : 'idle', appliedLeadMs: applied, playing };
  }

  /** Sends the status if it changed. */
  function postStatusNow(): void {
    if (!statusSink) return;
    const s = computeStatus();
    const key = JSON.stringify(s);
    if (key === lastStatusKey) return;
    lastStatusKey = key;
    statusSink(s);
  }

  /** Sends the status shortly, once for a burst of changes. */
  function postStatusSoon(): void {
    if (statusTimer || !statusSink) return;
    statusTimer = G.setTimeout(() => {
      statusTimer = 0;
      postStatusNow();
    }, 50);
  }

  // ---------------------------------------------------------- MSE
  if (hasMSE) installMSE();
  installElements();

  /** Patches MediaSource and SourceBuffer. */
  function installMSE(): void {
    const MSP = G.MediaSource.prototype;
    const SBP = G.SourceBuffer.prototype;
    const d = (o: object, k: string): PropertyDescriptor =>
      Object.getOwnPropertyDescriptor(o, k) ?? {};
    const getter = <T>(o: object, k: string) => d(o, k).get as (this: unknown) => T;
    const setter = <T>(o: object, k: string) => d(o, k).set as (this: unknown, v: T) => void;
    const N = {
      toGet: getter<number>(SBP, 'timestampOffset'),
      toSet: setter<number>(SBP, 'timestampOffset'),
      awsGet: getter<number>(SBP, 'appendWindowStart'),
      awsSet: setter<number>(SBP, 'appendWindowStart'),
      aweGet: getter<number>(SBP, 'appendWindowEnd'),
      aweSet: setter<number>(SBP, 'appendWindowEnd'),
      bufGet: getter<TimeRanges>(SBP, 'buffered'),
      updGet: getter<boolean>(SBP, 'updating'),
      modeGet: getter<AppendMode>(SBP, 'mode'),
      modeSet: setter<AppendMode>(SBP, 'mode'),
      append: SBP.appendBuffer,
      remove: SBP.remove,
      abort: SBP.abort,
      changeType: SBP.changeType as SourceBuffer['changeType'] | undefined,
      addSB: MSP.addSourceBuffer,
      removeSB: MSP.removeSourceBuffer,
      eos: MSP.endOfStream,
      rsGet: getter<ReadyState>(MSP, 'readyState'),
      durGet: getter<number>(MSP, 'duration'),
      durSet: setter<number>(MSP, 'duration'),
      msAEL: MSP.addEventListener,
      msREL: MSP.removeEventListener,
    };
    const TRP: object = G.TimeRanges ? G.TimeRanges.prototype : Object.prototype;
    const domErr = (name: string, msg?: string): DOMException =>
      new DOMException(msg || name, name);

    nat = (sb) => {
      try {
        const b = N.bufGet.call(sb);
        const o: [number, number][] = [];
        for (let i = 0; i < b.length; i++) o.push([b.start(i), b.end(i)]);
        return o;
      } catch {
        return [];
      }
    };
    nativeDuration = (ms) => N.durGet.call(ms);

    // ------------------------------------------------------ native helpers
    /**
     * Sets the native append window, in an order the setters accept.
     * @param sb - The SourceBuffer
     * @param aws - Window start
     * @param awe - Window end
     */
    function setWindow(sb: SourceBuffer, aws: number, awe: number): void {
      if (!(awe > aws)) awe = aws + 1e-3;
      if (aws >= N.aweGet.call(sb)) {
        N.aweSet.call(sb, awe);
        N.awsSet.call(sb, aws);
      } else {
        N.awsSet.call(sb, aws);
        N.aweSet.call(sb, awe);
      }
    }

    /**
     * Writes the player's settings, shifted, to the native SourceBuffer.
     * @param r - The record
     * @returns False when the native buffer is busy
     */
    function syncNative(r: Rec): boolean {
      const sb = r.sb;
      if (N.updGet.call(sb)) return false;
      if (r.v.mode !== N.modeGet.call(sb)) N.modeSet.call(sb, r.v.mode);
      N.toSet.call(sb, r.v.to + r.off);
      setWindow(sb, Math.max(0, r.v.aws + r.off), r.v.awe + r.off);
      return true;
    }

    /**
     * Runs one internal native operation and waits for its updateend.
     * @param r - The record
     * @param fn - Starts the operation
     * @returns Resolves at updateend, rejects on error or abort
     */
    function nativeOp(r: Rec, fn: () => void): Promise<void> {
      return new Promise((resolve, reject) => {
        r.opWait = { resolve, reject, err: null, started: false };
        try {
          fn();
        } catch (e) {
          r.opWait = null;
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    }

    /**
     * The player's view of a record's ranges.
     * @param r - The record
     * @returns Virtual ranges
     */
    function virtualOf(r: Rec): [number, number][] {
      const first = r.cache?.entries[0]?.vStart ?? null;
      return virtualRanges(nat(r.sb), r.off, r.v.aws, first);
    }

    /**
     * Makes a TimeRanges-like object.
     * @param list - The ranges
     * @returns An object the player can read like TimeRanges
     */
    function fakeRanges(list: readonly Range[]): TimeRanges {
      const chk = (i: number): void => {
        if (!(i >= 0 && i < list.length)) {
          throw domErr(
            'IndexSizeError',
            `The index provided (${i}) is greater than or equal to the maximum bound (${list.length}).`,
          );
        }
      };
      return Object.create(TRP, {
        length: { value: list.length, enumerable: true },
        start: {
          value: mask(function start(i: number) {
            chk(i);
            return list[i][0];
          }, 'start'),
        },
        end: {
          value: mask(function end(i: number) {
            chk(i);
            return list[i][1];
          }, 'end'),
        },
      }) as TimeRanges;
    }

    // ------------------------------------------------------ records
    const synthetic = new WeakSet<Event>();

    /**
     * Dispatches events the player is owed, one per task.
     * @param sb - The SourceBuffer
     * @param names - Event names, in order
     */
    function fire(sb: SourceBuffer, names: string[]): void {
      let i = 0;
      const next = (): void => {
        if (i >= names.length) return;
        const ev = new Event(names[i++]);
        synthetic.add(ev);
        nDispatch.call(sb, ev);
        G.setTimeout(next, 0);
      };
      G.setTimeout(next, 0);
    }

    /**
     * A player remove() that is empty natively still owes the player its events.
     * @param r - The record
     */
    function synthRemove(r: Rec): void {
      r.pendingAsync = true;
      const ev = (n: string): void => {
        const e = new Event(n);
        synthetic.add(e);
        nDispatch.call(r.sb, e);
      };
      G.setTimeout(() => {
        ev('updatestart');
        G.setTimeout(() => {
          r.pendingAsync = false;
          ev('update');
          ev('updateend');
        }, 0);
      }, 0);
    }

    /**
     * Marks a record as never shiftable.
     * @param r - The record
     * @param why - The reason
     */
    function markUnavailable(r: Rec, why: UnavailableReason): void {
      if (r.unavailable) return;
      r.unavailable = why;
      postStatusSoon();
    }

    /**
     * Makes a walker that feeds a record's init tracking and cache.
     * @param r - The record
     * @param fmt - The container
     * @returns The walker
     */
    function makeWalker(r: Rec, fmt: 'mp4' | 'webm'): SegmentWalker {
      return new SegmentWalker(
        fmt,
        {
          onInit(init) {
            const ref: InitRef = { bytes: init.bytes, encrypted: init.encrypted };
            r.currentInit = ref;
            r.nativeInit = ref;
            if (init.muxed) markUnavailable(r, 'muxed');
          },
          onFragment(f) {
            if (!r.cache || !r.currentInit) return;
            const e: CacheEntry = {
              data: f.data,
              init: r.currentInit,
              vTO: r.v.to,
              vAWS: r.v.aws,
              vAWE: r.v.awe,
              vStart: f.start + r.v.to,
              vEnd: f.end + r.v.to,
              frameDur: f.frameDur,
              syncs: f.nonSync ? f.syncs.map((t) => t + r.v.to) : null,
            };
            addEntry(r.cache, e);
            evict(r.cache, ctFor(r), r.off);
            // Whole-frame shifts were field-proven on MP4 audio only.
            if (r.fmt === 'mp4' && f.frameDur > 0) r.fd = f.frameDur;
          },
        },
        { fragments: r.kind === 'audio' },
      );
    }

    /**
     * Starts managing a new SourceBuffer.
     * @param ms - Its MediaSource
     * @param sb - The SourceBuffer
     * @param mime - The type it was created with
     * @returns The record
     */
    function manage(ms: MediaSource, sb: SourceBuffer, mime: string): Rec {
      const kind = classify(mime);
      const fmt = formatOf(mime);
      const r: Rec = {
        sb,
        ms,
        kind,
        fmt,
        v: { to: 0, aws: 0, awe: Infinity, mode: N.modeGet.call(sb) },
        off: 0,
        rateApplied: 1,
        internal: false,
        queue: [],
        pendingAsync: false,
        opWait: null,
        currentInit: null,
        nativeInit: null,
        cache: kind === 'audio' && fmt !== 'unknown' ? createCache() : null,
        walker: null,
        unavailable:
          kind === 'muxed' ? 'muxed' : kind === 'audio' && fmt === 'unknown' ? 'format' : null,
        everShifted: false,
        bufSnap: null,
        fd: 0,
        deferUntil: 0,
        deferSince: 0,
        deferKey: null,
      };
      if ((kind === 'audio' || kind === 'video') && fmt !== 'unknown')
        r.walker = makeWalker(r, fmt);
      recOf.set(sb, r);
      recs.add(r);
      let mi = msInfo.get(ms);
      if (!mi) {
        mi = {
          el: pendingBind.get(ms) ?? null,
          recs: new Set(),
          expect: { sourceopen: 0, sourceended: 0 },
          fakeEnded: false,
          deferred: [],
          latched: null,
          liveEdge: null,
          starve: 0,
        };
        msInfo.set(ms, mi);
        liveSources.add(ms);
        hookMsEvents(ms, mi);
      }
      mi.recs.add(r);
      // Nothing is buffered yet: the current target applies directly.
      try {
        r.rateApplied = rateFor(r);
        r.off = targetOff(r);
        if (r.off) {
          r.everShifted = true;
          syncNative(r);
        }
      } catch {
        r.off = 0;
      }
      // First listeners on the object: hide the events our own operations cause.
      for (const n of ['updatestart', 'update', 'updateend', 'error', 'abort']) {
        nAEL.call(sb, n, (ev: Event) => {
          if (synthetic.has(ev)) return;
          const w = r.opWait;
          if (!r.internal || !w) return;
          // Events still queued from a player operation that ended before
          // ours (the abort/updateend pair of a player abort()) belong to
          // the player: only events after our own updatestart are ours.
          if (n === 'updatestart') {
            if (w.started) return;
            w.started = true;
            ev.stopImmediatePropagation();
            return;
          }
          if (!w.started) return;
          ev.stopImmediatePropagation();
          if (n === 'error' || n === 'abort') w.err = n;
          if (n === 'updateend') {
            r.opWait = null;
            if (w.err) w.reject(new Error(`internal ${w.err}`));
            else w.resolve();
          }
        });
      }
      nAEL.call(sb, 'updateend', () => {
        if (r.internal) return;
        G.setTimeout(() => maybeSwitch(r), 0);
      });
      startTicker();
      return r;
    }

    /**
     * Stops managing a record.
     * @param r - The record
     */
    function unmanage(r: Rec): void {
      recs.delete(r);
      msInfo.get(r.ms)?.recs.delete(r);
      if (r.opWait) {
        const w = r.opWait;
        r.opWait = null;
        w.reject(new Error('removed'));
      }
    }

    // ------------------------------------------------------ MediaSource events
    const decided = new WeakMap<Event, boolean>();
    /**
     * Decides once per event whether it was caused by the hook.
     * @param ms - The MediaSource
     * @param ev - The event
     * @returns True to hide it from the player
     */
    function swallow(ms: MediaSource, ev: Event): boolean {
      const known = decided.get(ev);
      if (known !== undefined) return known;
      const mi = msInfo.get(ms);
      let s = false;
      const t = ev.type as 'sourceopen' | 'sourceended';
      if (mi && (t === 'sourceopen' || t === 'sourceended') && mi.expect[t] > 0) {
        mi.expect[t]--;
        s = true;
      }
      decided.set(ev, s);
      return s;
    }
    type Listener = EventListenerOrEventListenerObject;
    const wrapped = new WeakMap<object, Record<string, EventListener>>();
    const MS_EVENTS = new Set(['sourceopen', 'sourceended', 'sourceclose']);
    /**
     * Wraps a player's MediaSource listener so hidden events skip it.
     * @param type - The event type
     * @param fn - The player's listener
     * @returns The wrapper (the same one for the same listener)
     */
    function wrapListener(type: string, fn: Listener | null): Listener | null {
      if (!fn || (typeof fn !== 'function' && typeof fn.handleEvent !== 'function')) return fn;
      let m = wrapped.get(fn);
      if (!m) {
        m = {};
        wrapped.set(fn, m);
      }
      if (!m[type]) {
        m[type] = function (this: MediaSource, ev: Event) {
          if (swallow(this, ev)) return;
          return typeof fn === 'function' ? fn.call(this, ev) : fn.handleEvent(ev);
        };
      }
      return m[type];
    }
    MSP.addEventListener = mask(function addEventListener(
      this: MediaSource,
      type: string,
      fn: Listener | null,
      opts?: boolean | AddEventListenerOptions,
    ) {
      return N.msAEL.call(
        this,
        type,
        (MS_EVENTS.has(type) ? wrapListener(type, fn) : fn) as Listener,
        opts,
      );
    }, 'addEventListener');
    MSP.removeEventListener = mask(function removeEventListener(
      this: MediaSource,
      type: string,
      fn: Listener | null,
      opts?: boolean | EventListenerOptions,
    ) {
      const m = fn ? wrapped.get(fn) : undefined;
      return N.msREL.call(
        this,
        type,
        (MS_EVENTS.has(type) && m?.[type] ? m[type] : fn) as Listener,
        opts,
      );
    }, 'removeEventListener');
    for (const t of MS_EVENTS) {
      const dd = Object.getOwnPropertyDescriptor(MSP, 'on' + t);
      if (!dd?.get || !dd.set) continue;
      const g = dd.get;
      const s = dd.set;
      const orig = new WeakMap<object, unknown>();
      try {
        Object.defineProperty(MSP, 'on' + t, {
          configurable: true,
          enumerable: dd.enumerable,
          get: mask(function (this: MediaSource) {
            const h = g.call(this) as object | null;
            return h ? (orig.has(h) ? orig.get(h) : h) : h;
          }, 'get on' + t),
          set: mask(function (this: MediaSource, fn: unknown) {
            if (typeof fn !== 'function') return s.call(this, fn);
            const w = function (this: MediaSource, ev: Event): unknown {
              if (swallow(this, ev)) return undefined;
              return (fn as (e: Event) => unknown).call(this, ev);
            };
            orig.set(w, fn);
            s.call(this, w);
          }, 'set on' + t),
        });
      } catch {
        // leave the handler property native
      }
    }
    /**
     * Listens on a MediaSource first, so hidden events are decided even with
     * no player listener, and forgets its records when it closes.
     * @param ms - The MediaSource
     * @param mi - Its info
     */
    function hookMsEvents(ms: MediaSource, mi: MsInfo): void {
      for (const t of MS_EVENTS) N.msAEL.call(ms, t, (ev: Event) => void swallow(ms, ev));
      N.msAEL.call(ms, 'sourceclose', () => {
        for (const r of [...mi.recs]) unmanage(r);
        liveSources.delete(ms);
        postStatusSoon();
      });
    }
    const anyInternal = (ms: MediaSource): boolean => {
      const mi = msInfo.get(ms);
      if (!mi) return false;
      for (const r of mi.recs) if (r.internal) return true;
      return false;
    };
    patchAccessor(MSP, 'readyState', function (this: MediaSource) {
      const mi = msInfo.get(this);
      if (mi?.fakeEnded) return 'ended';
      return N.rsGet.call(this);
    });
    MSP.endOfStream = mask(function endOfStream(this: MediaSource, err?: EndOfStreamError) {
      if (anyInternal(this)) {
        const mi = msInfo.get(this);
        if (mi) {
          mi.deferred.push(() => {
            mi.fakeEnded = false;
            if (err === undefined) N.eos.call(this);
            else N.eos.call(this, err);
          });
          mi.fakeEnded = true;
        }
        return;
      }
      return err === undefined ? N.eos.call(this) : N.eos.call(this, err);
    }, 'endOfStream');
    patchAccessor(MSP, 'duration', null, function (this: MediaSource, v: number) {
      if (anyInternal(this)) {
        msInfo.get(this)?.deferred.push(() => N.durSet.call(this, v));
        return;
      }
      N.durSet.call(this, v);
    });
    MSP.addSourceBuffer = mask(function addSourceBuffer(this: MediaSource, mime: string) {
      const sb = N.addSB.call(this, mime);
      try {
        manage(this, sb, String(mime));
        postStatusSoon();
      } catch {
        // an unmanaged buffer simply stays native
      }
      return sb;
    }, 'addSourceBuffer');
    MSP.removeSourceBuffer = mask(function removeSourceBuffer(this: MediaSource, sb: SourceBuffer) {
      const r = recOf.get(sb);
      N.removeSB.call(this, sb);
      if (r) {
        unmanage(r);
        postStatusSoon();
      }
    }, 'removeSourceBuffer');

    // ------------------------------------------------------ SourceBuffer virtualisation
    /**
     * Replaces a prototype accessor, keeping whichever half is not given.
     * @param proto - The prototype
     * @param name - The property
     * @param get - New getter, or null to keep the native one
     * @param set - New setter, or null to keep the native one
     */
    function patchAccessor(
      proto: object,
      name: string,
      get: ((this: never) => unknown) | null,
      set: ((this: never, v: never) => void) | null = null,
    ): void {
      const dd = Object.getOwnPropertyDescriptor(proto, name);
      if (!dd) return;
      try {
        Object.defineProperty(proto, name, {
          configurable: true,
          enumerable: dd.enumerable,
          get: get ? mask(get, 'get ' + name) : dd.get,
          set: set ? mask(set, 'set ' + name) : dd.set,
        });
      } catch {
        // leave it native
      }
    }
    const shiftedEver = (r: Rec): boolean => r.off !== 0 || r.everShifted;
    patchAccessor(
      SBP,
      'timestampOffset',
      function (this: SourceBuffer) {
        const r = recOf.get(this);
        if (!r) return N.toGet.call(this);
        if (r.v.mode === 'sequence' && !r.internal && !r.pendingAsync && !N.updGet.call(this)) {
          r.v.to = N.toGet.call(this) - r.off;
        }
        return r.v.to;
      },
      function (this: SourceBuffer, x: number) {
        const r = recOf.get(this);
        if (!r) return N.toSet.call(this, x);
        if (r.pendingAsync) throw domErr('InvalidStateError');
        const v = +x;
        if (r.internal) {
          r.v.to = v;
          return;
        }
        N.toSet.call(this, v + r.off);
        r.v.to = v;
      },
    );
    patchAccessor(
      SBP,
      'appendWindowStart',
      function (this: SourceBuffer) {
        const r = recOf.get(this);
        return r ? r.v.aws : N.awsGet.call(this);
      },
      function (this: SourceBuffer, x: number) {
        const r = recOf.get(this);
        if (!r) return N.awsSet.call(this, x);
        if (r.pendingAsync) throw domErr('InvalidStateError');
        const v = +x;
        if (!(v >= 0) || v >= r.v.awe) {
          throw new TypeError(
            "Failed to set the 'appendWindowStart' property on 'SourceBuffer': invalid value",
          );
        }
        if (r.internal) {
          r.v.aws = v;
          return;
        }
        N.awsGet.call(this); // throws when the buffer was removed
        r.v.aws = v;
        setWindow(this, Math.max(0, v + r.off), r.v.awe + r.off);
      },
    );
    patchAccessor(
      SBP,
      'appendWindowEnd',
      function (this: SourceBuffer) {
        const r = recOf.get(this);
        return r ? r.v.awe : N.aweGet.call(this);
      },
      function (this: SourceBuffer, x: number) {
        const r = recOf.get(this);
        if (!r) return N.aweSet.call(this, x);
        if (r.pendingAsync) throw domErr('InvalidStateError');
        const v = +x;
        if (Number.isNaN(v) || v <= r.v.aws) {
          throw new TypeError(
            "Failed to set the 'appendWindowEnd' property on 'SourceBuffer': invalid value",
          );
        }
        if (r.internal) {
          r.v.awe = v;
          return;
        }
        r.v.awe = v;
        setWindow(this, Math.max(0, r.v.aws + r.off), v + r.off);
      },
    );
    patchAccessor(
      SBP,
      'mode',
      function (this: SourceBuffer) {
        const r = recOf.get(this);
        return r ? r.v.mode : N.modeGet.call(this);
      },
      function (this: SourceBuffer, m: AppendMode) {
        const r = recOf.get(this);
        if (!r) return N.modeSet.call(this, m);
        if (r.pendingAsync) throw domErr('InvalidStateError');
        if (r.internal) {
          if (m === 'segments' || m === 'sequence') r.v.mode = m;
          return;
        }
        N.modeSet.call(this, m);
        r.v.mode = N.modeGet.call(this);
      },
    );
    patchAccessor(SBP, 'updating', function (this: SourceBuffer) {
      const r = recOf.get(this);
      if (!r) return N.updGet.call(this);
      if (r.internal) return r.pendingAsync;
      return r.pendingAsync || N.updGet.call(this);
    });
    patchAccessor(SBP, 'buffered', function (this: SourceBuffer) {
      const nb = N.bufGet.call(this);
      const r = recOf.get(this);
      if (!r || !shiftedEver(r)) return nb;
      // Mid-switch the native buffer has a transient hole (removed, not yet
      // appended again): show the ranges from before the switch.
      if (r.internal && r.bufSnap) return fakeRanges(r.bufSnap);
      return fakeRanges(virtualOf(r));
    });

    // The element's buffered is the intersection of its SourceBuffers'
    // ranges; players read it too, so present the virtual intersection
    // whenever one of its buffers is shifted.
    const HMP = G.HTMLMediaElement?.prototype;
    const ebd = HMP ? Object.getOwnPropertyDescriptor(HMP, 'buffered') : undefined;
    const ebGet = ebd?.get;
    if (HMP && ebGet) {
      patchAccessor(HMP, 'buffered', function (this: HTMLMediaElement) {
        const nb = ebGet.call(this) as TimeRanges;
        let mine: Rec[] | null = null;
        for (const r of recs) {
          if (msInfo.get(r.ms)?.el === this) (mine ??= []).push(r);
        }
        if (!mine || !mine.some(shiftedEver)) return nb;
        try {
          const ended = N.rsGet.call(mine[0].ms) === 'ended';
          const lists = mine.map((r) => (r.internal && r.bufSnap ? r.bufSnap : virtualOf(r)));
          return fakeRanges(elementRanges(lists, ended));
        } catch {
          return nb;
        }
      });
    }

    SBP.appendBuffer = mask(function appendBuffer(this: SourceBuffer, data: BufferSource) {
      const r = recOf.get(this);
      if (!r) return N.append.call(this, data);
      if (r.pendingAsync) {
        throw domErr(
          'InvalidStateError',
          "Failed to execute 'appendBuffer' on 'SourceBuffer': This SourceBuffer is still processing an 'appendBuffer' or 'remove' operation.",
        );
      }
      const u8 =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (r.internal) {
        const copy = u8.slice();
        r.pendingAsync = true;
        r.queue.push(() => playerAppend(r, copy, copy));
        return;
      }
      playerAppend(r, u8, data);
    }, 'appendBuffer');

    /**
     * Appends for the player and follows the bytes.
     * @param r - The record
     * @param u8 - The bytes as a view
     * @param data - What the player passed
     */
    function playerAppend(r: Rec, u8: Uint8Array, data: BufferSource): void {
      N.append.call(r.sb, data);
      r.walker?.feed(u8);
      if (r.off !== 0) r.everShifted = true;
    }

    SBP.remove = mask(function remove(this: SourceBuffer, a: number, b: number) {
      const r = recOf.get(this);
      if (!r) return N.remove.call(this, a, b);
      if (r.pendingAsync) throw domErr('InvalidStateError');
      a = +a;
      b = +b;
      if (a < 0 && a > -(Math.abs(r.off) + 1)) a = 0; // times we may have mis-reported
      if (!(a >= 0) || Number.isNaN(b) || b <= a) {
        throw new TypeError(
          "Failed to execute 'remove' on 'SourceBuffer': The start provided is outside the range",
        );
      }
      // The player no longer wants this content: forget it in the cache too.
      if (r.cache) forgetRange(r.cache, a, b);
      const run = (): void => {
        let na = Math.max(0, a + r.off);
        const nb = b + r.off;
        // Never cut audio at the playhead because of the shift: a player's
        // flush just ahead of its playhead lands behind it natively.
        const ct = ctFor(r);
        if (r.off < 0 && ct !== null) {
          const guard = ct + 0.3 * rateFor(r);
          if (na < guard && nb > ct - 0.5) na = Math.max(na, guard);
        }
        if (nb > na + 1e-4) N.remove.call(r.sb, na, nb);
        else synthRemove(r);
      };
      if (r.internal) {
        r.pendingAsync = true;
        r.queue.push(run);
        return;
      }
      run();
    }, 'remove');

    SBP.abort = mask(function abort(this: SourceBuffer) {
      const r = recOf.get(this);
      if (!r) return N.abort.call(this);
      r.v.aws = 0;
      r.v.awe = Infinity;
      r.walker?.reset();
      if (r.internal) {
        if (r.pendingAsync) {
          r.queue.length = 0;
          r.pendingAsync = false;
          fire(this, ['abort', 'updateend']);
        }
        r.queue.push(() => {
          N.abort.call(r.sb);
          syncNative(r);
        });
        return;
      }
      N.abort.call(this);
      syncNative(r);
      G.setTimeout(() => maybeSwitch(r), 0);
    }, 'abort');

    const nChangeType = N.changeType;
    if (nChangeType) {
      SBP.changeType = mask(function changeType(this: SourceBuffer, mime: string) {
        const r = recOf.get(this);
        if (!r) return nChangeType.call(this, mime);
        if (r.pendingAsync) throw domErr('InvalidStateError');
        const doIt = (): void => {
          nChangeType.call(r.sb, mime);
          const kind = classify(mime);
          const fmt = formatOf(mime);
          if (kind !== r.kind || (r.kind === 'audio' && fmt === 'unknown'))
            markUnavailable(r, 'format');
          r.fmt = fmt;
          r.walker =
            fmt !== 'unknown' && (r.kind === 'audio' || r.kind === 'video')
              ? makeWalker(r, fmt)
              : null;
          r.currentInit = null;
          // Fragments of the old codec cannot be appended again after it.
          if (r.cache) r.cache = createCache();
        };
        if (r.internal) {
          r.queue.push(doIt);
          return;
        }
        doIt();
      }, 'changeType');
    }

    // ------------------------------------------------------ the immediate switch
    /**
     * Moves a record towards its target offset when it can.
     * @param r - The record
     */
    function maybeSwitch(r: Rec): void {
      if (!recs.has(r) || r.internal || r.kind !== 'audio') return;
      r.rateApplied = rescaleRate(rateFor(r), r.rateApplied, cmd.leadS, r.off);
      let want = targetOff(r);
      // Never apply an audio lead the live edge cannot feed.
      if (want < 0 && liveTooCloseFor(r, -want)) {
        latch(r.ms, 'live-edge');
        want = 0;
      }
      if (Math.abs(want - r.off) < 1e-6) {
        r.deferUntil = 0;
        r.deferSince = 0;
        r.deferKey = null;
        return;
      }
      if (r.deferUntil && now() < r.deferUntil) return;
      if (N.rsGet.call(r.ms) === 'closed') return;
      if (N.updGet.call(r.sb) || r.pendingAsync || (r.walker && !r.walker.atBoundary())) return;
      void doSwitch(r, want);
    }

    /**
     * Keeps the current offset and retries in a second.
     * @param r - The record
     * @param newOff - The offset wanted
     * @param why - Why it has to wait
     */
    function deferSwitch(r: Rec, newOff: number, why: string): void {
      r.deferUntil = now() + 1000;
      if (!r.deferSince) r.deferSince = now();
      const k = newOff.toFixed(4) + why;
      if (r.deferKey !== k) {
        r.deferKey = k;
        postStatusSoon();
      }
    }

    /**
     * Applies a new offset to a record: switch, drain or defer.
     * @param r - The record
     * @param newOff - The offset wanted
     */
    async function doSwitch(r: Rec, newOff: number): Promise<void> {
      const sb = r.sb;
      const ct = ctFor(r);
      if (r.cache) evict(r.cache, ct, r.off);
      const plan = planSwitch({
        ct,
        rate: rateFor(r),
        canCache: !!(r.walker && !r.walker.broken && r.currentInit && r.cache),
        fromOff: r.off,
        newOff,
        nonSync: !!r.cache?.nonSync,
        encrypted: encAudio(r),
        frameDur: r.fd,
        entries: r.cache?.entries ?? [],
        native: nat(sb),
      });
      if (plan.action === 'defer') {
        deferSwitch(r, newOff, plan.why);
        return;
      }
      r.deferUntil = 0;
      r.deferSince = 0;
      r.deferKey = null;
      if (plan.action === 'drain') {
        // The new offset applies to future appends only.
        r.off = newOff;
        r.everShifted = true;
        syncNative(r);
        postStatusSoon();
        return;
      }
      const mi = msInfo.get(r.ms);
      const wasEnded = N.rsGet.call(r.ms) === 'ended';
      r.everShifted = true;
      r.bufSnap = virtualOf(r);
      r.internal = true;
      postStatusSoon();
      try {
        if (wasEnded && mi) {
          mi.expect.sourceopen++;
          mi.fakeEnded = true;
        }
        setWindow(sb, 0, Infinity);
        await nativeOp(r, () => N.remove.call(sb, plan.cut, Infinity));
        r.off = newOff;
        if (r.v.mode === 'sequence') N.modeSet.call(sb, 'segments');
        let cur = r.nativeInit;
        // Non-sync audio: an init segment first, so Chrome drops (never
        // keeps a sliver of) the non-sync frame straddling the cut. Not for
        // an encrypted init, which would fire 'encrypted' again; the jump
        // back in decode time has the same effect there.
        const first = cur;
        if (r.cache?.nonSync && plan.list.length && first && !first.encrypted) {
          await nativeOp(r, () => N.append.call(sb, first.bytes as BufferSource));
        }
        for (const e of plan.list) {
          const aws = Math.max(0, plan.cut - plan.awsEps, e.vAWS + newOff);
          const awe = e.vAWE + newOff;
          if (!(awe > aws)) continue;
          if (e.init !== cur) {
            setWindow(sb, 0, Infinity);
            await nativeOp(r, () => N.append.call(sb, e.init.bytes as BufferSource));
            cur = e.init;
          }
          N.toSet.call(sb, e.vTO + newOff);
          setWindow(sb, aws, awe);
          await nativeOp(r, () => N.append.call(sb, e.data as BufferSource));
        }
        const latest = r.currentInit;
        if (latest && cur !== latest) {
          setWindow(sb, 0, Infinity);
          await nativeOp(r, () => N.append.call(sb, latest.bytes as BufferSource));
        }
        r.nativeInit = r.currentInit;
        syncNative(r);
        if (wasEnded && mi) {
          mi.expect.sourceended++;
          N.eos.call(r.ms);
        }
      } catch {
        try {
          r.off = newOff;
          syncNative(r);
        } catch {
          // the buffer is gone
        }
      } finally {
        if (wasEnded && mi) mi.fakeEnded = false;
        r.internal = false;
        r.bufSnap = null;
        r.pendingAsync = false;
        for (const fn of r.queue.splice(0)) {
          try {
            fn();
          } catch {
            // the player's queued call failed natively; nothing to report it to
          }
        }
        if (mi && mi.deferred.length && !anyInternal(r.ms)) {
          for (const fn of mi.deferred.splice(0)) {
            try {
              fn();
            } catch {
              // as above
            }
          }
        }
        postStatusSoon();
        G.setTimeout(() => maybeSwitch(r), 0);
      }
    }

    applyAll = () => {
      for (const r of recs) maybeSwitch(r);
      postStatusSoon();
    };
    switchTick = () => {
      for (const r of recs) if (!r.internal) maybeSwitch(r);
    };

    // ------------------------------------------------------ guards
    /**
     * Live-edge guard and starve counter for shifted live audio.
     */
    function liveGuard(): void {
      for (const r of recs) {
        if (r.kind !== 'audio' || r.off === 0) continue;
        const li = liveInfo(r);
        if (!li || !li.live) continue;
        const el = li.el;
        if (el.paused || el.seeking) continue;
        const mi = msInfo.get(r.ms);
        if (!mi) continue;
        let ahead = 0;
        for (const [s, e] of nat(r.sb)) {
          if (s <= el.currentTime + 0.1 && e > el.currentTime) ahead = e - el.currentTime;
        }
        mi.starve = nextStarve(mi.starve, ahead);
        const tooClose = li.dist !== null && liveTooClose(li.dist, -r.off);
        if (tooClose || starved(mi.starve)) latch(r.ms, 'live-edge');
      }
    }

    /**
     * Freeze watchdog: playback stuck with data at the playhead, or with a
     * hole only the shift explains, turns the lead off. Never seeks.
     */
    function freezeWatchdog(): void {
      const els = new Map<HTMLMediaElement, Rec[]>();
      for (const r of recs) {
        const el = msInfo.get(r.ms)?.el;
        if (!el || !r.everShifted) continue;
        const l = els.get(el);
        if (l) l.push(r);
        else els.set(el, [r]);
      }
      for (const el of [...freezeWatch.keys()]) if (!els.has(el)) freezeWatch.delete(el);
      for (const [el, list] of els) {
        const ct = el.currentTime;
        let hasData = false;
        const b = el.buffered;
        for (let i = 0; i < b.length; i++) {
          if (b.start(i) <= ct + 0.05 && b.end(i) > ct + 0.5) hasData = true;
        }
        let holeByShift = false;
        for (const r of list) {
          if (r.off === 0) continue;
          if (!nat(r.sb).some(([s, e]) => s <= ct + 0.05 && e > ct + 0.3)) holeByShift = true;
        }
        const v = freezeVerdict(freezeWatch.get(el) ?? null, {
          paused: el.paused,
          seeking: el.seeking,
          ended: el.ended,
          readyState: el.readyState,
          currentTime: ct,
          now: now(),
          hasData,
          holeByShift,
        });
        if (v.state) freezeWatch.set(el, v.state);
        else freezeWatch.delete(el);
        if (v.freeze) for (const r of list) latch(r.ms, 'freeze');
      }
    }

    guardTick = () => {
      if (!cmd.enabled) {
        freezeWatch.clear();
        return;
      }
      liveGuard();
      freezeWatchdog();
    };
  }

  // ---------------------------------------------------------- elements
  /** Tracks object URLs and the elements that play MediaSources. */
  function installElements(): void {
    if (G.URL && typeof G.URL.createObjectURL === 'function') {
      const nCOU = G.URL.createObjectURL;
      const nROU = G.URL.revokeObjectURL;
      G.URL.createObjectURL = mask(function createObjectURL(o: Blob | MediaSource) {
        const u = nCOU.call(G.URL, o);
        try {
          if (hasMSE && o instanceof G.MediaSource) urlToMs.set(u, o);
        } catch {
          // not ours
        }
        return u;
      }, 'createObjectURL');
      // Players (Shaka) revoke the URL right after attaching: keep the
      // mapping until the MediaSource closes so the element can be found.
      G.URL.revokeObjectURL = mask(function revokeObjectURL(u: string) {
        const ms = urlToMs.get(u);
        if (ms) {
          const mi = msInfo.get(ms);
          if (!mi || !mi.el) {
            try {
              nAEL.call(ms, 'sourceclose', () => urlToMs.delete(u), { once: true });
            } catch {
              urlToMs.delete(u);
            }
          } else {
            urlToMs.delete(u);
          }
        }
        return nROU.call(G.URL, u);
      }, 'revokeObjectURL');
    }
    const HMP = G.HTMLMediaElement?.prototype;
    if (!HMP) return;
    const sd = Object.getOwnPropertyDescriptor(HMP, 'src');
    const srcSet = sd?.set;
    if (sd && srcSet) {
      try {
        Object.defineProperty(HMP, 'src', {
          configurable: true,
          enumerable: sd.enumerable,
          get: sd.get,
          set: mask(function (this: HTMLMediaElement, u: string) {
            bindEl(this, String(u));
            return srcSet.call(this, u);
          }, 'set src'),
        });
      } catch {
        // leave it native
      }
    }
    const od = Object.getOwnPropertyDescriptor(HMP, 'srcObject');
    const objSet = od?.set;
    if (od && objSet) {
      try {
        Object.defineProperty(HMP, 'srcObject', {
          configurable: true,
          enumerable: od.enumerable,
          get: od.get,
          set: mask(function (this: HTMLMediaElement, o: unknown) {
            try {
              const Handle = (G as unknown as { MediaSourceHandle?: new () => object })
                .MediaSourceHandle;
              if (Handle && o instanceof Handle) {
                // A MediaSource in a worker: out of the hook's reach.
                handleEls.add(this);
                postStatusSoon();
              } else if (hasMSE && o instanceof G.MediaSource) bindMs(o, this);
            } catch {
              // not ours
            }
            return objSet.call(this, o);
          }, 'set srcObject'),
        });
      } catch {
        // leave it native
      }
    }
    // Players that set the src attribute inside a shadow root are missed by
    // the src setter and by document.querySelectorAll: bind them when they
    // start playing, so the switch and the watchdog have a playhead.
    const nPlay = HMP.play;
    if (typeof nPlay === 'function') {
      HMP.play = mask(function play(this: HTMLMediaElement) {
        try {
          const u = this.currentSrc || this.src;
          if (u && urlToMs.has(u)) bindEl(this, u);
        } catch {
          // not ours
        }
        return nPlay.call(this);
      }, 'play');
    }
  }

  // ---------------------------------------------------------- housekeeping
  /** Starts the periodic checks, once there is something to check. */
  function startTicker(): void {
    if (ticker) return;
    ticker = G.setInterval(() => {
      tickCount++;
      if (cmd.enabled && cmd.leadS > 0 && deadMan.check(now())) {
        // No word from the extension (reloaded, disabled or updated): lead off.
        cmd.enabled = false;
        cmd.leadS = 0;
        applyAll();
      }
      switchTick();
      if (tickCount % 2 === 0) guardTick();
      if (tickCount % 4 === 0) {
        for (const r of recs) if (r.kind === 'audio') liveInfo(r);
        if (cmd.heard) postStatusNow();
      }
    }, TICK_MS);
  }

  return {
    setLead(enabled: boolean, leadMs: number): void {
      cmd.heard = true;
      deadMan.heard(now());
      const leadS = Math.min(MAX_LEAD_MS, Math.max(0, leadMs)) / 1000;
      if (cmd.enabled === enabled && cmd.leadS === leadS) return;
      cmd.enabled = enabled;
      cmd.leadS = leadS;
      startTicker();
      applyAll();
      postStatusNow();
    },
    rearm(): void {
      cmd.heard = true;
      deadMan.heard(now());
      for (const ms of liveSources) {
        const mi = msInfo.get(ms);
        if (mi) {
          mi.latched = null;
          mi.starve = 0;
        }
      }
      freezeWatch.clear();
      applyAll();
      postStatusNow();
    },
    status: computeStatus,
    onStatus(fn: (s: HookStatus) => void): void {
      statusSink = fn;
      lastStatusKey = '';
    },
  };
}
