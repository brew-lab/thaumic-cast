// Handles lifecycle of the MV3 offscreen document used for tab audio capture
let offscreenCreated = false;
let offscreenReadyResolve: (() => void) | null = null;
let creationPromise: Promise<void> | null = null;

/**
 * Ensure offscreen document exists. Uses mutex to prevent race conditions
 * when multiple callers try to create the document simultaneously.
 */
export async function ensureOffscreen(): Promise<void> {
  // If creation is already in progress, wait for it
  if (creationPromise) {
    return creationPromise;
  }

  // If already created, return immediately
  if (offscreenCreated) return;

  // Start creation with mutex
  creationPromise = doEnsureOffscreen();
  try {
    await creationPromise;
  } finally {
    creationPromise = null;
  }
}

async function doEnsureOffscreen(): Promise<void> {
  // Double-check after acquiring mutex (another call may have completed)
  if (offscreenCreated) return;

  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });

  const expectedUrl = chrome.runtime.getURL('src/offscreen/offscreen.html');
  const hasMatchingContext = existingContexts.some(
    (ctx) => (ctx as { url?: string }).url === expectedUrl
  );

  if (hasMatchingContext) {
    offscreenCreated = true;
    return;
  }

  // Clean up stale offscreen documents pointing somewhere else
  for (const ctx of existingContexts) {
    if ((ctx as { url?: string }).url && (ctx as { url?: string }).url !== expectedUrl) {
      try {
        await chrome.offscreen.closeDocument();
      } catch {
        // Ignore failures closing stale contexts
      }
    }
  }

  // Create a promise that resolves when offscreen sends OFFSCREEN_READY
  const readyPromise = new Promise<void>((resolve) => {
    offscreenReadyResolve = resolve;
  });

  await chrome.offscreen.createDocument({
    url: 'src/offscreen/offscreen.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Capture and encode tab audio for streaming to Sonos',
  });

  // Wait for offscreen to signal it's ready (with timeout)
  const timeoutPromise = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error('Offscreen ready timeout')), 5000)
  );

  await Promise.race([readyPromise, timeoutPromise]);
  offscreenCreated = true;
}

export async function closeOffscreen(): Promise<void> {
  if (!offscreenCreated) return;

  try {
    // Send disconnect message to close WebSocket gracefully before destroying document
    await chrome.runtime.sendMessage({ type: 'WS_DISCONNECT' });
    // Small delay to allow WebSocket close to complete
    await new Promise((resolve) => setTimeout(resolve, 100));
    await chrome.offscreen.closeDocument();
  } catch {
    // Already closed or not yet created
  }
  offscreenCreated = false;
}

export function markOffscreenReady(): void {
  if (offscreenReadyResolve) {
    offscreenReadyResolve();
    offscreenReadyResolve = null;
  }
}

/**
 * Recover offscreen state on service worker startup.
 * Checks if an offscreen document already exists (from before service worker restart)
 * and updates the offscreenCreated flag accordingly.
 */
export async function recoverOffscreenState(): Promise<boolean> {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });

  const expectedUrl = chrome.runtime.getURL('src/offscreen/offscreen.html');
  const hasMatchingContext = existingContexts.some(
    (ctx) => (ctx as { url?: string }).url === expectedUrl
  );

  if (hasMatchingContext) {
    offscreenCreated = true;
    console.log('[OffscreenManager] Recovered existing offscreen document');
    return true;
  }

  offscreenCreated = false;
  return false;
}

/**
 * Send a message to the offscreen document with automatic recovery on context invalidation.
 * If the offscreen document has died, it will be recreated and the message resent.
 */
export async function sendToOffscreen<T = unknown>(message: object): Promise<T | undefined> {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Check if this is a context invalidation error (offscreen died or temporarily unreachable)
    if (
      errorMessage.includes('context invalidated') ||
      errorMessage.includes('Receiving end does not exist')
    ) {
      console.warn('[OffscreenManager] Offscreen context invalidated, checking state...');

      // Check if offscreen actually still exists before resetting state
      const existingContexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      });
      const expectedUrl = chrome.runtime.getURL('src/offscreen/offscreen.html');
      const stillExists = existingContexts.some(
        (ctx) => (ctx as { url?: string }).url === expectedUrl
      );

      if (stillExists) {
        // Document exists but message failed - just update flag and retry
        offscreenCreated = true;
        console.log('[OffscreenManager] Offscreen still exists, retrying message...');
        return await chrome.runtime.sendMessage(message);
      }

      // Document truly gone - recreate it
      console.log('[OffscreenManager] Offscreen gone, recreating...');
      offscreenCreated = false;
      creationPromise = null;

      try {
        await ensureOffscreen();
        // Retry the message once after recreation
        return await chrome.runtime.sendMessage(message);
      } catch (retryErr) {
        console.error('[OffscreenManager] Failed to send message after recreation:', retryErr);
        throw retryErr;
      }
    }

    throw err;
  }
}

/**
 * Check if the offscreen document is currently marked as created.
 */
export function isOffscreenCreated(): boolean {
  return offscreenCreated;
}
