import { describe, expect, it } from 'bun:test';
import { copyPendingText, type ClipboardEnv } from './clipboard';

/** A fake `ClipboardItem` that keeps what it was given. */
class FakeItem {
  constructor(readonly items: Record<string, string | Blob | PromiseLike<string | Blob>>) {}
}

interface Recorder {
  env: ClipboardEnv;
  writes: FakeItem[];
  texts: string[];
}

/**
 * A clipboard that records what it is asked to write.
 * @param options - How the fake behaves
 * @param options.refuseWrite - Whether `write` rejects
 * @param options.refuseWriteText - Whether `writeText` rejects
 * @param options.withItem - Whether `ClipboardItem` exists
 * @returns The fake clipboard and what was written to it
 */
function fakeClipboard({
  refuseWrite = false,
  refuseWriteText = false,
  withItem = true,
} = {}): Recorder {
  const writes: FakeItem[] = [];
  const texts: string[] = [];
  const clipboard = {
    async write(items: ClipboardItems): Promise<void> {
      writes.push(...(items as unknown as FakeItem[]));
      if (refuseWrite) throw new Error('NotAllowedError');
      const blob = await (writes[0]!.items['text/plain'] as Promise<Blob>);
      texts.push(await blob.text());
    },
    async writeText(text: string): Promise<void> {
      if (refuseWriteText) throw new Error('NotAllowedError');
      texts.push(text);
    },
  };
  return {
    env: {
      clipboard,
      ClipboardItem: withItem ? (FakeItem as unknown as typeof ClipboardItem) : undefined,
    },
    writes,
    texts,
  };
}

describe('copyPendingText', () => {
  it('should start the clipboard write before the text is ready', async () => {
    const fake = fakeClipboard();
    let resolve!: (text: string) => void;
    const pending = new Promise<string>((r) => (resolve = r));

    const done = copyPendingText(pending, fake.env);
    expect(fake.writes).toHaveLength(1);

    resolve('http://192.168.1.2:49400/stream/abc/listen');
    await done;
    expect(fake.texts).toEqual(['http://192.168.1.2:49400/stream/abc/listen']);
  });

  it('should fall back to writeText when a promised item is refused', async () => {
    const fake = fakeClipboard({ refuseWrite: true });
    await copyPendingText(Promise.resolve('url'), fake.env);
    expect(fake.writes).toHaveLength(1);
    expect(fake.texts).toEqual(['url']);
  });

  it('should use writeText where there is no ClipboardItem', async () => {
    const fake = fakeClipboard({ withItem: false });
    await copyPendingText(Promise.resolve('url'), fake.env);
    expect(fake.writes).toHaveLength(0);
    expect(fake.texts).toEqual(['url']);
  });

  it('should reject when the clipboard refuses both ways', async () => {
    const fake = fakeClipboard({ refuseWrite: true, refuseWriteText: true });
    await expect(copyPendingText(Promise.resolve('url'), fake.env)).rejects.toThrow();
    expect(fake.texts).toHaveLength(0);
  });

  it('should reject without copying when there is no text', async () => {
    const fake = fakeClipboard();
    const missing = Promise.reject(new Error('no address'));
    await expect(copyPendingText(missing, fake.env)).rejects.toThrow('no address');
    expect(fake.texts).toHaveLength(0);
  });
});
