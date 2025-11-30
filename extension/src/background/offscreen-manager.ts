// Handles lifecycle of the MV3 offscreen document used for tab audio capture
let offscreenCreated = false;
let offscreenReadyResolve: (() => void) | null = null;

export async function ensureOffscreen(): Promise<void> {
  if (offscreenCreated) return;

  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });

  if (existingContexts.length > 0) {
    offscreenCreated = true;
    return;
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
