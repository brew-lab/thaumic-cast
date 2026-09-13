import { describe, expect, it } from 'bun:test';

import {
  WsControlCommandSchema,
  WsInitialStateMessageSchema,
  WsMessageSchema,
  type WsMessage,
} from './websocket.js';

const SPEAKER = '192.168.1.10';

describe('WsMessageSchema', () => {
  it('should apply encoder defaults inside a HANDSHAKE payload', () => {
    const parsed = WsMessageSchema.parse({
      type: 'HANDSHAKE',
      payload: { encoderConfig: { codec: 'pcm', bitrate: 0 } },
    });

    expect(parsed.type === 'HANDSHAKE' && parsed.payload.encoderConfig.sampleRate).toBe(48000);
  });

  it('should accept payload-less heartbeat and stop messages', () => {
    expect(WsMessageSchema.safeParse({ type: 'HEARTBEAT' }).success).toBe(true);
    expect(WsMessageSchema.safeParse({ type: 'HEARTBEAT_ACK' }).success).toBe(true);
    expect(WsMessageSchema.safeParse({ type: 'STOP_STREAM' }).success).toBe(true);
  });

  it('should default videoSyncEnabled to false on START_PLAYBACK', () => {
    const parsed = WsMessageSchema.parse({
      type: 'START_PLAYBACK',
      payload: { speakerIp: SPEAKER },
    });

    expect(parsed.type === 'START_PLAYBACK' && parsed.payload.videoSyncEnabled).toBe(false);
  });

  it('should require a message on ERROR payloads', () => {
    expect(WsMessageSchema.safeParse({ type: 'ERROR', payload: {} }).success).toBe(false);
    expect(WsMessageSchema.safeParse({ type: 'ERROR', payload: { message: 'x' } }).success).toBe(
      true,
    );
  });

  it('should reject a message type it does not know', () => {
    expect(WsMessageSchema.safeParse({ type: 'INITIAL_STATE', payload: {} }).success).toBe(false);
  });

  it('should carry per-speaker results on PLAYBACK_RESULTS', () => {
    const message: WsMessage = {
      type: 'PLAYBACK_RESULTS',
      payload: {
        results: [
          { speakerIp: SPEAKER, success: true, streamUrl: 'http://companion/stream/s1' },
          { speakerIp: '192.168.1.11', success: false, error: 'unreachable' },
        ],
      },
    };

    expect(WsMessageSchema.parse(message)).toEqual(message);
  });
});

describe('WsInitialStateMessageSchema', () => {
  it('should accept the snapshot from a companion that predates the newer fields', () => {
    const parsed = WsInitialStateMessageSchema.parse({
      type: 'INITIAL_STATE',
      payload: { groups: [], transportStates: {}, groupVolumes: {}, groupMutes: {} },
    });

    expect(parsed.payload.groupVolumeFixed).toEqual({});
    expect(parsed.payload.sessions).toBeUndefined();
    expect(parsed.payload.protocolVersion).toBeUndefined();
  });
});

describe('WsControlCommandSchema', () => {
  it('should keep SET_VOLUME within 0-100 whole numbers', () => {
    const command = (volume: number) => ({ type: 'SET_VOLUME', payload: { ip: SPEAKER, volume } });

    expect(WsControlCommandSchema.safeParse(command(0)).success).toBe(true);
    expect(WsControlCommandSchema.safeParse(command(100)).success).toBe(true);
    expect(WsControlCommandSchema.safeParse(command(101)).success).toBe(false);
    expect(WsControlCommandSchema.safeParse(command(50.5)).success).toBe(false);
  });

  it('should accept a known removal reason on STOP_PLAYBACK_SPEAKER and reject unknown ones', () => {
    const command = (reason?: string) => ({
      type: 'STOP_PLAYBACK_SPEAKER',
      payload: { streamId: 's1', ip: SPEAKER, reason },
    });

    expect(WsControlCommandSchema.safeParse(command()).success).toBe(true);
    expect(WsControlCommandSchema.safeParse(command('speaker_taken_over')).success).toBe(true);
    expect(WsControlCommandSchema.safeParse(command('because')).success).toBe(false);
  });
});
