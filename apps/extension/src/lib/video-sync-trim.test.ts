import { beforeEach, describe, expect, it } from 'bun:test';
import type { ZoneGroup } from '@thaumic-cast/protocol';

import { chromeStorageData, resetChromeStub } from '../test-support/chrome-stub';
import {
  VIDEO_SYNC_TRIM_STORAGE_KEY,
  clampTrim,
  loadSpeakerTrim,
  saveSpeakerTrim,
  speakerUuid,
} from './video-sync-trim';

const GROUPS: ZoneGroup[] = [
  {
    id: 'g1',
    name: 'Kitchen',
    coordinatorUuid: 'RINCON_KITCHEN',
    coordinatorIp: '192.168.1.20',
    members: [
      { uuid: 'RINCON_KITCHEN', ip: '192.168.1.20', zoneName: 'Kitchen' },
      { uuid: 'RINCON_SUB', ip: '192.168.1.22', zoneName: 'Kitchen' },
    ],
  },
];

describe('video sync trims', () => {
  beforeEach(() => resetChromeStub());

  it('should find a speaker UUID by address', () => {
    expect(speakerUuid('192.168.1.22', GROUPS)).toBe('RINCON_SUB');
    expect(speakerUuid('192.168.1.99', GROUPS)).toBeUndefined();
  });

  it('should round trip a trim under the speaker UUID', async () => {
    expect(await loadSpeakerTrim('192.168.1.20', GROUPS)).toBe(0);
    expect(await saveSpeakerTrim('192.168.1.20', GROUPS, 40)).toBe(40);
    expect(chromeStorageData.local[VIDEO_SYNC_TRIM_STORAGE_KEY]).toEqual({ RINCON_KITCHEN: 40 });
    expect(await loadSpeakerTrim('192.168.1.20', GROUPS)).toBe(40);
  });

  it('should follow the speaker to a new address by its UUID', async () => {
    await saveSpeakerTrim('192.168.1.20', GROUPS, -30);
    const moved = [
      {
        ...GROUPS[0],
        coordinatorIp: '192.168.1.50',
        members: [{ uuid: 'RINCON_KITCHEN', ip: '192.168.1.50', zoneName: 'Kitchen' }],
      },
    ];
    expect(await loadSpeakerTrim('192.168.1.50', moved)).toBe(-30);
  });

  it('should fall back to the address when the UUID is not known', async () => {
    await saveSpeakerTrim('192.168.1.30', GROUPS, 20);
    expect(chromeStorageData.local[VIDEO_SYNC_TRIM_STORAGE_KEY]).toEqual({ '192.168.1.30': 20 });
    expect(await loadSpeakerTrim('192.168.1.30', [])).toBe(20);
  });

  it('should move an address entry to the UUID once the UUID is known', async () => {
    await saveSpeakerTrim('192.168.1.20', [], 10);
    expect(await loadSpeakerTrim('192.168.1.20', GROUPS)).toBe(10);
    await saveSpeakerTrim('192.168.1.20', GROUPS, 20);
    expect(chromeStorageData.local[VIDEO_SYNC_TRIM_STORAGE_KEY]).toEqual({ RINCON_KITCHEN: 20 });
  });

  it('should drop stored entries that fail validation and keep the rest', async () => {
    chromeStorageData.local[VIDEO_SYNC_TRIM_STORAGE_KEY] = {
      RINCON_KITCHEN: 'loud',
      RINCON_SUB: 9000,
      '192.168.1.30': 30,
    };
    expect(await loadSpeakerTrim('192.168.1.20', GROUPS)).toBe(0);
    expect(await loadSpeakerTrim('192.168.1.22', GROUPS)).toBe(0);
    expect(await loadSpeakerTrim('192.168.1.30', GROUPS)).toBe(30);
  });

  it('should read a stored value that is not a record as no trims', async () => {
    chromeStorageData.local[VIDEO_SYNC_TRIM_STORAGE_KEY] = [1, 2, 3];
    expect(await loadSpeakerTrim('192.168.1.20', GROUPS)).toBe(0);
    await saveSpeakerTrim('192.168.1.20', GROUPS, 10);
    expect(chromeStorageData.local[VIDEO_SYNC_TRIM_STORAGE_KEY]).toEqual({ RINCON_KITCHEN: 10 });
  });

  it('should clamp and step a trim', () => {
    expect(clampTrim(123)).toBe(120);
    expect(clampTrim(-9000)).toBe(-500);
    expect(clampTrim(9000)).toBe(500);
    expect(clampTrim(Number.NaN)).toBe(0);
    expect(Object.is(clampTrim(-1), 0)).toBe(true);
  });
});
