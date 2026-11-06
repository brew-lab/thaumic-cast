import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { stopOffscreenSession } from './offscreen-manager';

const runtime = chrome.runtime as unknown as Record<string, unknown>;
const realSendMessage = runtime.sendMessage;

/** Messages the document was sent. */
let sent: unknown[];

/**
 * Sets what Chrome reports and how the send goes.
 * @param documents - How many offscreen documents exist
 * @param answer - What the send does
 */
function given(documents: number, answer: () => Promise<unknown>): void {
  runtime.getContexts = async () => Array.from({ length: documents }, () => ({}));
  runtime.sendMessage = (message: unknown) => {
    sent.push(message);
    return answer();
  };
}

beforeEach(() => {
  sent = [];
  runtime.ContextType = { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' };
});

afterEach(() => {
  runtime.sendMessage = realSendMessage;
  delete runtime.getContexts;
  delete runtime.ContextType;
});

describe('stopOffscreenSession', () => {
  it('should resolve without sending when there is no document, its capture gone with it', async () => {
    given(0, async () => undefined);
    await stopOffscreenSession(1);
    expect(sent).toEqual([]);
  });

  it('should send the stop to the document and resolve on its success', async () => {
    given(1, async () => ({ success: true }));
    await stopOffscreenSession(1);
    expect(sent).toEqual([{ type: 'STOP_SESSION', payload: { tabId: 1 }, target: 'offscreen' }]);
  });

  it('should reject with the reason when the document says the stop failed', async () => {
    given(1, async () => ({ success: false, error: 'it broke' }));
    await expect(stopOffscreenSession(1)).rejects.toThrow('it broke');
  });

  it('should reject when a document that exists answers with nothing', async () => {
    given(1, async () => undefined);
    await expect(stopOffscreenSession(1)).rejects.toThrow('did not answer');
  });

  it('should reject when the send itself fails', async () => {
    given(1, async () => {
      throw new Error('Offscreen message timed out');
    });
    await expect(stopOffscreenSession(1)).rejects.toThrow('timed out');
  });
});
