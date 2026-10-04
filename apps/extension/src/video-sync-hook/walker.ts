/**
 * Streaming segment walker for the video sync hook.
 *
 * Players append media in pieces that need not end on a box or element
 * boundary. The walker follows the top-level structure across appends and
 * reports each complete init segment and media fragment (fMP4 moof+mdat, or a
 * WebM Cluster, including clusters of unknown size). It never throws: bytes
 * it cannot follow mark it broken, and it then stays quiet until reset.
 */

import { concat, rd32, typ } from './bytes';
import { fragmentSpan, parseInit, type Mp4InitInfo } from './mp4';
import {
  EBML_ID,
  EBML_LEVEL1,
  clusterCacheSpan,
  clusterSpan,
  dataStart,
  vint,
  webmTimecodeScale,
  webmTrackInfo,
  type WebmTrack,
} from './webm';

/** Container formats the walker follows. */
export type WalkerFormat = 'mp4' | 'webm';

/**
 * A complete init segment.
 */
export interface WalkedInit {
  /** The init segment's bytes (ftyp+moov, or EBML header through Tracks). */
  bytes: Uint8Array;
  /** Audio and video in the one init. */
  muxed: boolean;
  /** The init declares encryption. */
  encrypted: boolean;
}

/**
 * A complete media fragment, timed in track seconds before timestampOffset.
 */
export interface WalkedFragment {
  /** The fragment's bytes, ready to append again. */
  data: Uint8Array;
  start: number;
  end: number;
  /** Duration of the first frame, 0 when unknown. */
  frameDur: number;
  /** Number of frames flagged non-sync. */
  nonSync: number;
  /** Sync frame times when `nonSync > 0`, else empty. */
  syncs: number[];
}

/**
 * Receives what the walker finds.
 */
export interface WalkerSink {
  onInit(init: WalkedInit): void;
  onFragment(fragment: WalkedFragment): void;
}

/**
 * Options for a walker.
 */
export interface WalkerOptions {
  /**
   * Report media fragments. When false only init segments are reported and
   * fragment bytes are skipped without being kept.
   */
  fragments: boolean;
}

/** MP4 boxes that may sit before a moof and belong to its fragment. */
const MP4_PREFIX = new Set(['styp', 'sidx', 'emsg', 'prft']);
/** WebM level-1 elements kept as part of the init segment. */
const WEBM_INIT_EXTRA = new Set<number>([EBML_ID.SeekHead, EBML_ID.Void, EBML_ID.Tags]);

/**
 * Follows a SourceBuffer's appended bytes and reports init segments and
 * fragments.
 */
export class SegmentWalker {
  /** Set once the bytes stopped making sense; cleared by {@link reset}. */
  broken = false;

  private pend: Uint8Array | null = null;
  private pieces: Uint8Array[] = [];
  private need = 0;
  private store = false;
  private curId: string | number = 0;
  // mp4
  private initParts: Uint8Array[] = [];
  private prefix: Uint8Array[] = [];
  private entryParts: Uint8Array[] | null = null;
  private entryMoof: Uint8Array | null = null;
  private mp4Init: Mp4InitInfo | null = null;
  // webm
  private webmInit: Uint8Array[] = [];
  private timecodeScale = 1e6;
  private track: WebmTrack | null = null;
  private clusterOpen = false;
  private clusterParts: Uint8Array[] = [];

  /**
   * Creates a walker.
   * @param fmt - The container format
   * @param sink - Receives init segments and fragments
   * @param opts - What to report
   */
  constructor(
    readonly fmt: WalkerFormat,
    private readonly sink: WalkerSink,
    private readonly opts: WalkerOptions,
  ) {}

  /**
   * Forgets any partial box or element, as SourceBuffer.abort() makes the
   * parser do. The init in force is kept.
   */
  reset(): void {
    this.broken = false;
    this.pend = null;
    this.pieces = [];
    this.need = 0;
    this.initParts = [];
    this.prefix = [];
    this.entryParts = null;
    this.entryMoof = null;
    this.webmInit = [];
    this.clusterOpen = false;
    this.clusterParts = [];
  }

  /**
   * Whether the bytes seen so far end on a fragment boundary, so a switch may
   * re-append without splitting the player's fragment.
   * @returns True at a boundary (or when broken, since nothing is tracked then)
   */
  atBoundary(): boolean {
    if (this.broken) return true;
    if (this.fmt === 'mp4') {
      return this.need === 0 && !this.pend && !this.entryParts && this.initParts.length === 0;
    }
    return this.need === 0 && !this.pend && !this.clusterOpen;
  }

  /**
   * Takes the next appended bytes. The walker copies whatever it keeps, so
   * the caller may reuse `u8` afterwards.
   * @param u8 - The appended bytes
   */
  feed(u8: Uint8Array): void {
    if (this.broken) return;
    try {
      if (this.fmt === 'webm') this.feedWebm(u8);
      else this.feedMp4(u8);
    } catch {
      this.broken = true;
    }
  }

  /**
   * Keeps a piece of the current box or element: a view when it completes in
   * this append (concat copies it then), a copy when it continues later.
   * @param u8 - The appended bytes
   * @param s - Start of the piece
   * @param e - End of the piece
   * @param complete - The box or element ends with this piece
   */
  private keepPiece(u8: Uint8Array, s: number, e: number, complete: boolean): void {
    this.pieces.push(complete ? u8.subarray(s, e) : u8.slice(s, e));
  }

  /**
   * Walks fMP4 boxes.
   * @param u8 - The appended bytes
   */
  private feedMp4(u8: Uint8Array): void {
    let o = 0;
    while (o < u8.length) {
      if (this.need > 0) {
        const take = Math.min(this.need, u8.length - o);
        this.need -= take;
        if (this.store) this.keepPiece(u8, o, o + take, this.need === 0);
        o += take;
        if (this.need === 0) this.mp4Box(this.curId as string);
        continue;
      }
      const had = this.pend ? this.pend.length : 0;
      const hdr = this.pend
        ? concat([this.pend, u8.subarray(o, Math.min(u8.length, o + 16))])
        : u8.subarray(o, Math.min(u8.length, o + 16));
      if (hdr.length < 8) {
        this.pend = hdr.slice();
        return;
      }
      let size = rd32(hdr, 0);
      const t = typ(hdr, 4);
      let headerLen = 8;
      if (size === 1) {
        if (hdr.length < 16) {
          this.pend = hdr.slice();
          return;
        }
        size = rd32(hdr, 8) * 4294967296 + rd32(hdr, 12);
        headerLen = 16;
      } else if (size === 0) {
        size = had + (u8.length - o); // to the end of this append
      }
      if (size < headerLen || !/^[\x20-\x7e]{4}$/.test(t)) {
        this.broken = true;
        return;
      }
      const fromThis = Math.min(size - had, u8.length - o);
      this.store =
        t === 'ftyp' ||
        t === 'moov' ||
        t === 'moof' ||
        (this.opts.fragments && (t === 'mdat' || MP4_PREFIX.has(t) || this.entryParts !== null));
      this.pieces = [];
      this.need = size - had - fromThis;
      if (this.store) {
        if (this.pend) this.pieces.push(this.pend);
        this.keepPiece(u8, o, o + fromThis, this.need === 0);
      }
      this.pend = null;
      this.curId = t;
      o += fromThis;
      if (this.need === 0) this.mp4Box(t);
    }
  }

  /**
   * Handles a complete MP4 box.
   * @param t - The box type
   */
  private mp4Box(t: string): void {
    const bytes = this.store ? concat(this.pieces) : null;
    this.pieces = [];
    if (t === 'ftyp') {
      if (bytes) this.initParts = [bytes];
      return;
    }
    if (t === 'moov') {
      if (!bytes) return;
      const init = concat([...this.initParts, bytes]);
      this.initParts = [];
      const info = parseInit(init);
      this.mp4Init = info;
      this.sink.onInit({ bytes: init, muxed: info.muxed, encrypted: info.encrypted });
      return;
    }
    if (MP4_PREFIX.has(t)) {
      if (bytes && this.opts.fragments) this.prefix.push(bytes);
      return;
    }
    if (t === 'moof') {
      this.initParts = []; // an ftyp never followed by a moov
      this.entryParts = this.opts.fragments && bytes ? [...this.prefix, bytes] : [];
      this.entryMoof = bytes;
      this.prefix = [];
      return;
    }
    if (t === 'mdat') {
      const parts = this.entryParts;
      this.entryParts = null;
      if (!parts || !this.opts.fragments || !bytes || !this.mp4Init || !this.entryMoof) return;
      const span = fragmentSpan(this.entryMoof, this.mp4Init);
      if (!span) return;
      parts.push(bytes);
      this.sink.onFragment({
        data: concat(parts),
        start: span.start,
        end: span.end,
        frameDur: span.frameDur,
        nonSync: span.nonSync,
        syncs: span.syncs,
      });
      return;
    }
    if (this.entryParts && bytes && this.opts.fragments) this.entryParts.push(bytes);
  }

  /**
   * Whether a WebM element's bytes are kept.
   * @param id - The element ID
   * @returns True to keep them
   */
  private webmKeeps(id: number): boolean {
    if (id === EBML_ID.Cluster) return this.opts.fragments;
    return (
      id === EBML_ID.EBML ||
      id === EBML_ID.Info ||
      id === EBML_ID.Tracks ||
      WEBM_INIT_EXTRA.has(id) ||
      (this.clusterOpen && this.opts.fragments)
    );
  }

  /**
   * Walks WebM elements: the EBML header, the Segment (entered), and the
   * Segment's children.
   * @param u8 - The appended bytes
   */
  private feedWebm(u8: Uint8Array): void {
    const buf = this.pend ? concat([this.pend, u8]) : u8;
    this.pend = null;
    let o = 0;
    if (this.need > 0) {
      const take = Math.min(this.need, buf.length);
      this.need -= take;
      if (this.store) this.keepPiece(buf, 0, take, this.need === 0);
      o = take;
      if (this.need === 0) this.webmEl(this.curId as number);
    }
    while (o < buf.length) {
      const id = vint(buf, o, true);
      const sz = id ? vint(buf, o + id.len, false) : null;
      if (!id || !sz) {
        this.pend = buf.slice(o);
        return;
      }
      const h = id.len + sz.len;
      if (id.v === EBML_ID.Segment) {
        this.webmInit.push(buf.slice(o, o + h));
        o += h;
        continue;
      }
      if (this.clusterOpen && (EBML_LEVEL1.has(id.v) || id.v === EBML_ID.EBML)) {
        this.closeCluster();
      }
      if (id.v === EBML_ID.Cluster && sz.unknown) {
        // Unknown size: walk its children until the next level-1 element.
        this.clusterOpen = true;
        this.clusterParts = this.opts.fragments ? [buf.slice(o, o + h)] : [];
        o += h;
        continue;
      }
      if (sz.unknown) {
        this.broken = true;
        return;
      }
      const total = h + sz.v;
      const avail = Math.min(total, buf.length - o);
      this.store = this.webmKeeps(id.v);
      this.pieces = [];
      this.need = total - avail;
      if (this.store) this.keepPiece(buf, o, o + avail, this.need === 0);
      this.curId = id.v;
      o += avail;
      if (this.need === 0) this.webmEl(id.v);
    }
  }

  /**
   * Handles a complete WebM element.
   * @param id - The element ID
   */
  private webmEl(id: number): void {
    const bytes = this.store ? concat(this.pieces) : null;
    this.pieces = [];
    if (this.clusterOpen) {
      if (bytes) this.clusterParts.push(bytes);
      return;
    }
    if (!bytes) return;
    if (id === EBML_ID.EBML) {
      this.webmInit = [bytes];
      return;
    }
    if (id === EBML_ID.Info) {
      this.timecodeScale = webmTimecodeScale(bytes);
      this.webmInit.push(bytes);
      return;
    }
    if (id === EBML_ID.Tracks) {
      const info = webmTrackInfo(bytes);
      this.track = info.tracks[0] ?? null;
      this.webmInit.push(bytes);
      const init = concat(this.webmInit);
      this.webmInit = [];
      this.sink.onInit({ bytes: init, muxed: info.muxed, encrypted: info.encrypted });
      return;
    }
    if (id === EBML_ID.Cluster) {
      this.emitCluster(bytes);
      return;
    }
    if (this.webmInit.length && WEBM_INIT_EXTRA.has(id)) this.webmInit.push(bytes);
  }

  /**
   * Reports a complete Cluster as a fragment.
   * @param bytes - The whole Cluster element
   */
  private emitCluster(bytes: Uint8Array): void {
    if (!this.opts.fragments) return;
    const p0 = dataStart(bytes);
    if (p0 < 0) return;
    const span = clusterCacheSpan(bytes, p0, this.timecodeScale);
    if (!span) return;
    const exact = clusterSpan(bytes, p0, {
      timecodeScale: this.timecodeScale,
      track: this.track,
    });
    this.sink.onFragment({
      data: bytes,
      start: span.start,
      end: span.end,
      frameDur: exact?.frameDur ?? 0,
      nonSync: 0,
      syncs: [],
    });
  }

  /** Ends a Cluster of unknown size and reports it. */
  private closeCluster(): void {
    this.clusterOpen = false;
    const parts = this.clusterParts;
    this.clusterParts = [];
    if (!this.opts.fragments || !parts.length) return;
    this.emitCluster(concat(parts));
  }
}
