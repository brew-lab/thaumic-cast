import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { KeyedError, errorParamsOf } from '../lib/keyed-error';
import { StreamSession } from './stream-session';
import type { WorkerOutboundMessage } from './worker-messages';

/**
 * Stand-in for the session's worker. It answers the init message with
 * CONNECTED, as a worker whose handshake succeeded does, and lets the test
 * post anything else the worker would.
 */
class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((event: MessageEvent<WorkerOutboundMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: Array<{ type: string }> = [];

  /** Records the instance so the test can reach it. */
  constructor() {
    FakeWorker.last = this;
  }

  /**
   * Records a message from the session and answers an init with CONNECTED.
   * @param msg - The message the session posted
   * @param msg.type - Its type
   */
  postMessage(msg: { type: string }): void {
    this.posted.push(msg);
    if (msg.type.startsWith('INIT')) {
      queueMicrotask(() => this.emit({ type: 'CONNECTED', streamId: 'stream-1' }));
    }
  }

  /**
   * Delivers a worker message to the session.
   * @param msg - The message the worker would post
   */
  emit(msg: WorkerOutboundMessage): void {
    this.onmessage?.({ data: msg } as MessageEvent<WorkerOutboundMessage>);
  }

  /** Does nothing; the fake has no thread to end. */
  terminate(): void {}
}

const RATE_PARAMS = { rate: 44100, declared: 48000 };

describe('StreamSession: a rate stop before STREAM_READY', () => {
  const realWorker = globalThis.Worker;
  let errors: Array<{ error: string; reason?: string }>;
  let session: StreamSession;
  let worker: FakeWorker;

  beforeEach(async () => {
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    errors = [];
    // Browser capture has no audio pipeline to set up; the worker messages
    // under test are handled the same way for every session.
    session = StreamSession.forBrowserCapture(
      { codec: 'pcm', sampleRate: 48000, channels: 2 } as never,
      'http://127.0.0.1:1',
      undefined,
      (error, reason) => errors.push({ error, reason }),
    );
    await session.init();
    worker = FakeWorker.last!;
  });

  afterEach(() => {
    session.stop();
    globalThis.Worker = realWorker;
  });

  it('should reject waitForReady with the keyed error and its params, not time out', async () => {
    const ready = session.waitForReady(5000);
    const started = performance.now();
    worker.emit({ type: 'CAPTURE_RATE_ERROR', reason: 'pcm_rate_changed', params: RATE_PARAMS });

    const err = await ready.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyedError);
    expect((err as Error).message).toBe('auto_stop_pcm_rate_changed');
    expect(errorParamsOf(err)).toEqual(RATE_PARAMS);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(errors).toEqual([{ error: 'auto_stop_pcm_rate_changed', reason: 'pcm_rate_changed' }]);
  });

  it('should fail a waitForReady that starts after the rate stop', async () => {
    worker.emit({
      type: 'CAPTURE_RATE_ERROR',
      reason: 'pcm_rate_unsupported',
      params: RATE_PARAMS,
    });

    const err = await session.waitForReady(5000).catch((e: unknown) => e);
    expect((err as Error).message).toBe('auto_stop_pcm_rate_unsupported');
    expect(errorParamsOf(err)).toEqual(RATE_PARAMS);
  });

  it('should fail startPlayback with the keyed error after the rate stop', async () => {
    worker.emit({ type: 'CAPTURE_RATE_ERROR', reason: 'pcm_rate_changed', params: RATE_PARAMS });

    const err = await session.startPlayback(['192.168.1.20']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyedError);
    expect(errorParamsOf(err)).toEqual(RATE_PARAMS);
  });

  it('should still resolve waitForReady on STREAM_READY', async () => {
    const ready = session.waitForReady(5000);
    worker.emit({ type: 'STREAM_READY', bufferSize: 3 } as WorkerOutboundMessage);
    await ready;
  });
});

describe('StreamSession: overlapping playback starts', () => {
  const realWorker = globalThis.Worker;
  let session: StreamSession;
  let worker: FakeWorker;

  beforeEach(async () => {
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    session = StreamSession.forBrowserCapture(
      { codec: 'pcm', sampleRate: 48000, channels: 2 } as never,
      'http://127.0.0.1:1',
    );
    await session.init();
    worker = FakeWorker.last!;
    const ready = session.waitForReady(5000);
    worker.emit({ type: 'STREAM_READY', bufferSize: 3 } as WorkerOutboundMessage);
    await ready;
  });

  afterEach(() => {
    session.stop();
    globalThis.Worker = realWorker;
  });

  const starts = (): string[][] =>
    worker.posted
      .filter((msg) => msg.type === 'START_PLAYBACK')
      .map((msg) => (msg as unknown as { speakerIps: string[] }).speakerIps);

  const results = (ip: string, success: boolean): WorkerOutboundMessage =>
    ({ type: 'PLAYBACK_RESULTS', results: [{ speakerIp: ip, success }] }) as WorkerOutboundMessage;

  it('should send a second start only after the first has its results, and give each its own', async () => {
    const first = session.startPlayback(['10.0.0.1']);
    const second = session.startPlayback(['10.0.0.2']);
    await Promise.resolve();
    expect(starts()).toEqual([['10.0.0.1']]);

    worker.emit(results('10.0.0.1', true));
    expect(await first).toEqual([{ speakerIp: '10.0.0.1', success: true }]);
    await Promise.resolve();
    expect(starts()).toEqual([['10.0.0.1'], ['10.0.0.2']]);

    worker.emit(results('10.0.0.2', false));
    expect(await second).toEqual([{ speakerIp: '10.0.0.2', success: false }]);
  });

  it("should not let an earlier call's timer drop a later call's results", async () => {
    const first = session.startPlayback(['10.0.0.1'], undefined, false, false, undefined, 20);
    await Promise.resolve();
    worker.emit(results('10.0.0.1', true));
    await first;

    // The first call's 20 ms timer would have run out by now; the add is still waiting.
    const add = session.startPlayback(['10.0.0.2'], undefined, false, false, undefined, 1000);
    await new Promise((resolve) => setTimeout(resolve, 40));
    worker.emit(results('10.0.0.2', true));
    expect(await add).toEqual([{ speakerIp: '10.0.0.2', success: true }]);
  });

  it('should start the next call after one times out', async () => {
    const first = session.startPlayback(['10.0.0.1'], undefined, false, false, undefined, 10);
    const second = session.startPlayback(['10.0.0.2'], undefined, false, false, undefined, 1000);
    expect(await first.catch((e: Error) => e.message)).toBe(
      'Timeout waiting for playback to start',
    );
    await Promise.resolve();
    worker.emit(results('10.0.0.2', true));
    expect(await second).toEqual([{ speakerIp: '10.0.0.2', success: true }]);
  });

  it("should ignore a timed-out call's late results instead of handing them to the next", async () => {
    const first = session.startPlayback(['10.0.0.1'], undefined, false, false, undefined, 10);
    const second = session.startPlayback(['10.0.0.2'], undefined, false, false, undefined, 1000);
    await first.catch(() => undefined);
    await Promise.resolve();
    worker.emit(results('10.0.0.1', true));
    worker.emit(results('10.0.0.2', false));
    expect(await second).toEqual([{ speakerIp: '10.0.0.2', success: false }]);
  });
});
