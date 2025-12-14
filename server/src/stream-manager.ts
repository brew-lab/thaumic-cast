import type { ServerWebSocket } from 'bun';
import type { StreamMetadata, SonosEvent } from '@thaumic-cast/shared';
import { verifyIngestToken } from './jwt';

const MAX_BUFFER_FRAMES = 300; // ~10 seconds at 30fps MP3 frames
const MAX_SUBSCRIBERS = 5;

/** ICY metadata interval (bytes between metadata blocks) */
export const ICY_METAINT = 8192;

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
  private metadata: StreamMetadata = {};
  private _speakerIp: string | null = null;

  constructor(id: string) {
    this.id = id;
  }

  setMetadata(metadata: StreamMetadata): void {
    this.metadata = metadata;
  }

  getMetadata(): StreamMetadata {
    return this.metadata;
  }

  /**
   * Set the Sonos speaker IP this stream is playing on
   * Used for GENA event routing
   */
  setSpeakerIp(ip: string): void {
    this._speakerIp = ip;
  }

  /**
   * Get the Sonos speaker IP this stream is playing on
   */
  get speakerIp(): string | null {
    return this._speakerIp;
  }

  attachIngress(ws: ServerWebSocket<WebSocketData>): void {
    this.ingressSockets.add(ws);
  }

  detachIngress(ws: ServerWebSocket<WebSocketData>): void {
    this.ingressSockets.delete(ws);
  }

  /**
   * Send a Sonos event to all connected ingress WebSockets
   * Events are sent as JSON text (not binary) so extension can distinguish from audio
   */
  sendEvent(event: SonosEvent): void {
    const json = JSON.stringify(event);
    for (const ws of this.ingressSockets) {
      try {
        ws.send(json);
      } catch (err) {
        console.error(`[StreamState] Failed to send event to WebSocket:`, err);
      }
    }
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

  /**
   * Find stream by speaker IP address
   * Used by GENA listener to route events to the correct stream
   */
  getByIp(speakerIp: string): StreamState | undefined {
    for (const stream of this.streams.values()) {
      if (stream.speakerIp === speakerIp) {
        return stream;
      }
    }
    return undefined;
  }

  /**
   * Send event to stream by ID
   */
  sendEvent(streamId: string, event: SonosEvent): boolean {
    const stream = this.streams.get(streamId);
    if (stream) {
      stream.sendEvent(event);
      return true;
    }
    return false;
  }

  /**
   * Send event to stream by speaker IP
   * Returns true if a matching stream was found
   */
  sendEventByIp(speakerIp: string, event: SonosEvent): boolean {
    const stream = this.getByIp(speakerIp);
    if (stream) {
      stream.sendEvent(event);
      console.log(`[StreamManager] Sent ${event.type} event to stream ${stream.id}`);
      return true;
    }
    console.log(`[StreamManager] No stream found for speaker IP ${speakerIp}`);
    return false;
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

/**
 * Format metadata as an ICY metadata block
 * Format: [1 byte length (N*16)] [StreamTitle='...'; padded to N*16 bytes]
 */
export function formatIcyMetadata(metadata: StreamMetadata): Uint8Array {
  const title =
    metadata.artist && metadata.title
      ? `${metadata.artist} - ${metadata.title}`
      : metadata.title || metadata.artist || '';

  if (!title) {
    // Empty metadata block (just a zero byte)
    return new Uint8Array([0]);
  }

  // Escape single quotes in title
  const escapedTitle = title.replace(/'/g, "\\'");
  const metaStr = `StreamTitle='${escapedTitle}';`;
  const encoder = new TextEncoder();
  const metaBytes = encoder.encode(metaStr);

  // Calculate number of 16-byte blocks needed
  const lenBlocks = Math.ceil(metaBytes.length / 16);
  const paddedLen = lenBlocks * 16;

  const result = new Uint8Array(paddedLen + 1);
  result[0] = lenBlocks;
  result.set(metaBytes, 1);
  // Rest is already zeros (Uint8Array default)
  return result;
}
