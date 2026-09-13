import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { getStreamingPolicy } from '@thaumic-cast/protocol';

import {
  createWorkerState,
  enqueueFrame,
  flushFrameQueue,
  flushQueuedFrames,
  FRAME_QUEUE_MAX_BYTES,
  FRAME_QUEUE_TARGET_BYTES,
  isWsBackpressured,
  sendOrEnqueue,
  type WorkerState,
} from './worker-base';

/**
 * Stand-in for the streaming WebSocket. Every send grows `bufferedAmount` the
 * way a real socket does until the test drains it, so backpressure can be
 * driven from the test without timing.
 */
interface FakeSocket {
  readyState: number;
  bufferedAmount: number;
  sent: Uint8Array[];
  send(frame: Uint8Array): void;
}

function createSocket(readyState: number = WebSocket.OPEN): FakeSocket {
  return {
    readyState,
    bufferedAmount: 0,
    sent: [],
    send(frame) {
      this.sent.push(frame);
      this.bufferedAmount += frame.byteLength;
    },
  };
}

function frame(marker: number, length = 4): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(length)).fill(marker);
}

function markers(frames: Uint8Array[]): number[] {
  return frames.map((f) => f[0]!);
}

/** A worker state with a fresh socket and a policy whose high-water mark fits small test frames. */
function createState(
  mode: 'quality' | 'realtime',
  socket: FakeSocket,
  wsBufferHighWater = 8,
): WorkerState {
  const state = createWorkerState('test-worker');
  state.socket = socket as unknown as WebSocket;
  state.policy = { ...getStreamingPolicy(mode), wsBufferHighWater };
  // Overflow trimming logs a warning; keep the test output readable.
  spyOn(state.log, 'warn').mockImplementation(() => {});
  return state;
}

let socket: FakeSocket;

beforeEach(() => {
  socket = createSocket();
});

describe('isWsBackpressured', () => {
  it('should report backpressure once the socket buffer reaches the high-water mark', () => {
    const state = createState('quality', socket, 8);

    expect(isWsBackpressured(state)).toBe(false);
    socket.bufferedAmount = 8;
    expect(isWsBackpressured(state)).toBe(true);
  });

  it('should report no backpressure without a socket or policy', () => {
    expect(isWsBackpressured(createWorkerState('bare'))).toBe(false);
  });
});

describe('sendOrEnqueue in realtime mode', () => {
  it('should send straight to the socket when there is room', () => {
    const state = createState('realtime', socket);

    expect(sendOrEnqueue(state, frame(1))).toBe(true);
    expect(markers(socket.sent)).toEqual([1]);
    expect(state.frameQueue).toHaveLength(0);
  });

  it('should drop the frame instead of queueing when the socket is backpressured', () => {
    const state = createState('realtime', socket);
    socket.bufferedAmount = 8;

    expect(sendOrEnqueue(state, frame(1))).toBe(false);
    expect(socket.sent).toHaveLength(0);
    expect(state.frameQueue).toHaveLength(0);
  });
});

describe('sendOrEnqueue in quality mode', () => {
  it('should send straight to the socket when the queue is empty and there is room', () => {
    const state = createState('quality', socket);

    expect(sendOrEnqueue(state, frame(1))).toBe(true);
    expect(markers(socket.sent)).toEqual([1]);
    expect(state.frameQueue).toHaveLength(0);
  });

  it('should queue the frame instead of dropping it when the socket is backpressured', () => {
    const state = createState('quality', socket);
    socket.bufferedAmount = 8;

    expect(sendOrEnqueue(state, frame(1))).toBe(true);
    expect(socket.sent).toHaveLength(0);
    expect(markers(state.frameQueue)).toEqual([1]);
    expect(state.frameQueueBytes).toBe(4);
  });

  it('should flush queued frames ahead of a new frame once the socket has room', () => {
    const state = createState('quality', socket, 100);
    socket.bufferedAmount = 100;
    sendOrEnqueue(state, frame(1));
    sendOrEnqueue(state, frame(2));
    socket.bufferedAmount = 0;

    sendOrEnqueue(state, frame(3));

    expect(markers(socket.sent)).toEqual([1, 2, 3]);
    expect(state.frameQueue).toHaveLength(0);
  });

  it('should append behind frames that could not be flushed so order is preserved', () => {
    // High-water mark of 8 with 4-byte frames: only two sends fit before the socket fills.
    const state = createState('quality', socket, 8);
    socket.bufferedAmount = 8;
    sendOrEnqueue(state, frame(1));
    sendOrEnqueue(state, frame(2));
    sendOrEnqueue(state, frame(3));
    socket.bufferedAmount = 0;

    sendOrEnqueue(state, frame(4));

    expect(markers(socket.sent)).toEqual([1, 2]);
    expect(markers(state.frameQueue)).toEqual([3, 4]);
  });

  it('should copy the frame on request so a reused buffer cannot corrupt the queue', () => {
    const state = createState('quality', socket);
    socket.bufferedAmount = 8;
    const reused = frame(1);

    sendOrEnqueue(state, reused, true);
    reused.fill(9);

    expect(markers(state.frameQueue)).toEqual([1]);
  });

  it('should refuse to send or queue while the socket is not open', () => {
    const state = createState('quality', createSocket(WebSocket.CLOSED));

    expect(sendOrEnqueue(state, frame(1))).toBe(false);
    expect(state.frameQueue).toHaveLength(0);
  });
});

describe('enqueueFrame overflow', () => {
  it('should drop the oldest frames down to the target size and count them', () => {
    const state = createState('quality', socket);
    const mib = 1024 * 1024;
    const frameCount = Math.ceil(FRAME_QUEUE_MAX_BYTES / mib) + 1;

    for (let i = 1; i <= frameCount; i++) enqueueFrame(state, frame(i, mib));

    expect(state.frameQueueBytes).toBeLessThanOrEqual(FRAME_QUEUE_TARGET_BYTES);
    expect(state.frameQueueBytes).toBe(state.frameQueue.length * mib);
    expect(state.frameQueueOverflowDrops).toBe(frameCount - state.frameQueue.length);
    expect(markers(state.frameQueue).at(-1)).toBe(frameCount);
    expect(markers(state.frameQueue)).toEqual(
      markers(state.frameQueue).map((_, i, all) => all[0]! + i),
    );
  });
});

describe('flushFrameQueue', () => {
  it('should send queued frames in order until the socket fills and report the count', () => {
    const state = createState('quality', socket, 8);
    for (const marker of [1, 2, 3]) enqueueFrame(state, frame(marker));

    expect(flushFrameQueue(state)).toBe(2);
    expect(markers(socket.sent)).toEqual([1, 2]);
    expect(markers(state.frameQueue)).toEqual([3]);
    expect(state.frameQueueBytes).toBe(4);
  });

  it('should send nothing while the socket is not open', () => {
    const state = createState('quality', createSocket(WebSocket.CONNECTING));
    enqueueFrame(state, frame(1));

    expect(flushFrameQueue(state)).toBe(0);
    expect(markers(state.frameQueue)).toEqual([1]);
  });
});

describe('flushQueuedFrames', () => {
  it('should drain the whole queue on shutdown regardless of backpressure', () => {
    const state = createState('quality', socket, 8);
    for (const marker of [1, 2, 3, 4]) enqueueFrame(state, frame(marker));
    socket.bufferedAmount = 8;

    flushQueuedFrames(state);

    expect(markers(socket.sent)).toEqual([1, 2, 3, 4]);
    expect(state.frameQueue).toHaveLength(0);
    expect(state.frameQueueBytes).toBe(0);
  });

  it('should keep the queue when the socket is already gone', () => {
    const state = createState('quality', createSocket(WebSocket.CLOSED));
    enqueueFrame(state, frame(1));

    flushQueuedFrames(state);

    expect(markers(state.frameQueue)).toEqual([1]);
  });
});
