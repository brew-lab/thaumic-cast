import type { ServerWebSocket } from 'bun';
import { verifyIngestToken } from './jwt';

const MAX_BUFFER_FRAMES = 300; // ~10 seconds at 30fps MP3 frames
const MAX_SUBSCRIBERS = 5;

interface WebSocketData {
  streamId: string;
}

interface Subscriber {
  controller: ReadableStreamDefaultController<Uint8Array>;
  active: boolean;
}

class StreamState {
  readonly id: string;
  private ingressSockets: Set<ServerWebSocket<WebSocketData>> = new Set();
  private subscribers: Set<Subscriber> = new Set();
  private buffer: Uint8Array[] = [];

  constructor(id: string) {
    this.id = id;
  }

  attachIngress(ws: ServerWebSocket<WebSocketData>): void {
    this.ingressSockets.add(ws);
  }

  detachIngress(ws: ServerWebSocket<WebSocketData>): void {
    this.ingressSockets.delete(ws);
  }

  pushFrame(frame: Uint8Array): void {
    // Add to buffer
    this.buffer.push(frame);

    // Evict oldest frames if over limit
    while (this.buffer.length > MAX_BUFFER_FRAMES) {
      this.buffer.shift();
    }

    // Broadcast to all subscribers
    for (const subscriber of this.subscribers) {
      if (subscriber.active) {
        try {
          subscriber.controller.enqueue(frame);
        } catch {
          // Subscriber closed, mark inactive
          subscriber.active = false;
        }
      }
    }

    // Clean up inactive subscribers
    for (const subscriber of this.subscribers) {
      if (!subscriber.active) {
        this.subscribers.delete(subscriber);
      }
    }
  }

  createReadableStream(): ReadableStream<Uint8Array> {
    if (this.subscribers.size >= MAX_SUBSCRIBERS) {
      throw new Error('Max subscribers reached');
    }

    let subscriber: Subscriber;

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        subscriber = { controller, active: true };
        this.subscribers.add(subscriber);

        // Pre-fill with buffered frames for faster start
        for (const frame of this.buffer) {
          controller.enqueue(frame);
        }
      },

      cancel: () => {
        if (subscriber) {
          subscriber.active = false;
          this.subscribers.delete(subscriber);
        }
      },
    });
  }

  get hasIngress(): boolean {
    return this.ingressSockets.size > 0;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}

class StreamManagerClass {
  private streams: Map<string, StreamState> = new Map();

  getOrCreate(id: string): StreamState {
    let stream = this.streams.get(id);
    if (!stream) {
      stream = new StreamState(id);
      this.streams.set(id, stream);
    }
    return stream;
  }

  get(id: string): StreamState | undefined {
    return this.streams.get(id);
  }

  async validateToken(streamId: string, token: string): Promise<boolean> {
    const result = await verifyIngestToken(token);
    if (!result) return false;
    return result.streamId === streamId;
  }

  remove(id: string): void {
    this.streams.delete(id);
  }

  get activeStreams(): number {
    return this.streams.size;
  }
}

export const StreamManager = new StreamManagerClass();
