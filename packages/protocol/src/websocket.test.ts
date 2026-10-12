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

  it('should accept the START_PLAYBACK message core parses, start volume included', () => {
    // A thaumic-core test parses this same file, so both sides agree on it.
    const fixture: unknown = JSON.parse(
      readFileSync(join(import.meta.dir, '../fixtures/start-playback.json'), 'utf8'),
    );

    const parsed = WsMessageSchema.parse(fixture);

    expect(parsed.type).toBe('START_PLAYBACK');
    if (parsed.type !== 'START_PLAYBACK') return;
    expect(parsed.payload.speakerIps).toEqual(['192.168.1.10', '192.168.1.11']);
    expect(parsed.payload.startVolume).toEqual({
      limit: 30,
      rooms: { RINCON_000E58A0B1C2D01400: 45 },
    });
    expect(parsed.payload.rooms).toEqual([
      'RINCON_000E58A0B1C2D01400',
      'RINCON_000E58A0B1C3D01400',
    ]);
    expect(parsed.payload.callId).toBe('4f1c2a:2');
  });

  it('should still accept the START_PLAYBACK an older extension sends', () => {
    // A thaumic-core test parses this same file and takes the legacy path.
    const fixture: unknown = JSON.parse(
      readFileSync(join(import.meta.dir, '../fixtures/start-playback-legacy.json'), 'utf8'),
    );

    const parsed = WsMessageSchema.parse(fixture);

    expect(parsed.type).toBe('START_PLAYBACK');
    if (parsed.type !== 'START_PLAYBACK') return;
    expect(parsed.payload.rooms).toBeUndefined();
    expect(parsed.payload.callId).toBeUndefined();
    expect(parsed.payload.syncSpeakers).toBe(true);
  });

  it('should accept the PLAYBACK_RESULTS core serialises, call id included', () => {
    // A thaumic-core test builds its PLAYBACK_RESULTS and compares it with
    // this same file.
    const fixture: unknown = JSON.parse(
      readFileSync(join(import.meta.dir, '../fixtures/playback-results.json'), 'utf8'),
    );

    const parsed = WsMessageSchema.parse(fixture);

    expect(parsed).toEqual(fixture as WsMessage);
    expect(parsed.type === 'PLAYBACK_RESULTS' && parsed.payload.callId).toBe('4f1c2a:2');
  });

  it('should accept replies without a call id from an older companion', () => {
    const results = WsMessageSchema.parse({
      type: 'PLAYBACK_RESULTS',
      payload: { results: [{ speakerIp: SPEAKER, success: true }] },
    });
    const error = WsMessageSchema.parse({
      type: 'PLAYBACK_ERROR',
      payload: { message: 'No speaker IPs provided' },
    });

    expect(results.type === 'PLAYBACK_RESULTS' && results.payload.callId).toBeUndefined();
    expect(error.type === 'PLAYBACK_ERROR' && error.payload.callId).toBeUndefined();
    expect(
      WsMessageSchema.safeParse({
        type: 'PLAYBACK_ERROR',
        payload: { message: 'x', callId: 'abc:1' },
      }).success,
    ).toBe(true);
  });

  it('should leave the start volume out of a START_PLAYBACK that has none', () => {
    const parsed = WsMessageSchema.parse({
      type: 'START_PLAYBACK',
      payload: { speakerIps: [SPEAKER] },
    });

    expect(parsed.type === 'START_PLAYBACK' && parsed.payload.startVolume).toBeUndefined();
  });

  it('should reject start levels outside 0 to 100', () => {
    const message = (startVolume: unknown) => ({
      type: 'START_PLAYBACK',
      payload: { speakerIps: [SPEAKER], startVolume },
    });

    expect(WsMessageSchema.safeParse(message({ limit: 101 })).success).toBe(false);
    expect(WsMessageSchema.safeParse(message({ limit: -1 })).success).toBe(false);
    expect(WsMessageSchema.safeParse(message({ rooms: { RINCON_A: 30.5 } })).success).toBe(false);
    expect(WsMessageSchema.safeParse(message({ limit: 0, rooms: {} })).success).toBe(true);
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

  it('should read whether the companion regroups rooms', () => {
    const body = { status: 'ok', service: 'thaumic-cast' };

    expect(HealthResponseSchema.parse({ ...body, regroup: true }).regroup).toBe(true);
    expect(HealthResponseSchema.parse(body).regroup).toBeUndefined();
    expect(HealthResponseSchema.parse({ ...body, regroup: 'yes' }).regroup).toBeUndefined();
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
