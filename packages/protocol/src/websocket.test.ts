import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  HealthResponseSchema,
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

  it('should accept the ERROR message exactly as core serialises it', () => {
    // A thaumic-core test builds its ERROR message and compares it with this
    // same file, so the two sides cannot drift apart unnoticed.
    const fixture: unknown = JSON.parse(
      readFileSync(join(import.meta.dir, '../fixtures/ws-error.json'), 'utf8'),
    );

    const parsed = WsMessageSchema.parse(fixture);

    expect(parsed).toEqual(fixture as WsMessage);
    expect(parsed.type === 'ERROR' && parsed.payload.message).toBe('Unsupported codec "opus"');
  });

  it('should reject the ERROR shape core used to send', () => {
    expect(WsMessageSchema.safeParse({ type: 'ERROR', message: 'x' }).success).toBe(false);
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

describe('HealthResponseSchema', () => {
  it('should read the capture capability a companion reports', () => {
    const parsed = HealthResponseSchema.parse({
      status: 'ok',
      service: 'thaumic-cast',
      appType: 'desktop',
      browserCapture: true,
      limits: { maxStreams: 10 },
    });

    expect(parsed).toMatchObject({
      service: 'thaumic-cast',
      appType: 'desktop',
      browserCapture: true,
      limits: { maxStreams: 10 },
    });
  });

  it('should leave the capability unknown for a companion that predates it', () => {
    const parsed = HealthResponseSchema.parse({
      status: 'ok',
      service: 'thaumic-cast',
      appType: 'server',
      limits: { maxStreams: 10 },
    });

    expect(parsed.browserCapture).toBeUndefined();
    expect(parsed.appType).toBe('server');
  });

  it('should degrade a field it does not recognise instead of failing', () => {
    const parsed = HealthResponseSchema.safeParse({
      service: 'thaumic-cast',
      appType: 'cli',
      browserCapture: 'yes',
      limits: { maxStreams: 0 },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.appType).toBeUndefined();
    expect(parsed.success && parsed.data.browserCapture).toBeUndefined();
    expect(parsed.success && parsed.data.limits?.maxStreams).toBeUndefined();
  });

  it('should accept the body of a companion from before appType and limits', () => {
    expect(HealthResponseSchema.safeParse({ status: 'ok', service: 'thaumic-cast' }).success).toBe(
      true,
    );
  });
});
