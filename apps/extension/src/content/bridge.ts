/**
 * The media bridge's logic, kept apart from its entry (media-bridge.ts) so tests can run it
 * against a fake runtime and window.
 *
 * A content script outlives its extension: when the extension reloads, updates or is turned
 * off, the scripts already in open tabs keep running, but every chrome.runtime call throws
 * "Extension context invalidated" synchronously (a `.catch` on the promise never sees it).
 * The bridge checks the context before each call and, once it is gone, removes its listeners
 * and stops for good. The tab's next page load gets the new extension's scripts.
 */

import { METADATA_EVENT, REQUEST_EVENT, CONTROL_EVENT } from './constants';

/** A runtime.onMessage listener. */
type MessageListener = (
  message: { type?: unknown; action?: unknown },
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean;

/** The part of chrome.runtime the bridge uses. */
export interface BridgeRuntime {
  /** The extension's id; undefined once the context is invalidated. */
  readonly id: string | undefined;
  /** Sends a message to the extension. */
  sendMessage(message: unknown): Promise<unknown>;
  /** Messages from the extension. */
  readonly onMessage: {
    addListener(listener: MessageListener): void;
    removeListener(listener: MessageListener): void;
  };
}

/** The page the bridge runs in. */
export interface BridgePage {
  /** The page's window, which carries the events to and from media-reader. */
  readonly win: Pick<Window, 'addEventListener' | 'removeEventListener' | 'dispatchEvent'>;
  /** The page's document, for its og:image. */
  readonly doc: Pick<
    Document,
    'readyState' | 'querySelector' | 'addEventListener' | 'removeEventListener'
  >;
}

/**
 * Whether the extension context this script belongs to is still valid.
 * @param runtime - The runtime the script started with
 * @returns False once the extension has reloaded, updated or been turned off
 */
export function isContextValid(runtime: BridgeRuntime): boolean {
  try {
    return runtime.id !== undefined;
  } catch {
    return false;
  }
}

/**
 * Starts the bridge between media-reader (MAIN world) and the extension.
 * @param runtime - chrome.runtime
 * @param page - The page's window and document
 * @returns Stops the bridge and removes its listeners (it also stops itself once the extension
 *   context is invalidated)
 */
export function startMediaBridge(runtime: BridgeRuntime, page: BridgePage): () => void {
  const { win, doc } = page;
  let stopped = false;

  /**
   * Sends a message to the extension, or stops the bridge if the extension has gone.
   * @param message - The message
   */
  function send(message: unknown): void {
    if (stopped) return;
    if (!isContextValid(runtime)) {
      stop();
      return;
    }
    try {
      // The background may not be awake or listening yet; that is not the bridge's concern.
      runtime.sendMessage(message).catch(() => undefined);
    } catch {
      // Thrown synchronously when the context was invalidated between the check and the call.
      if (!isContextValid(runtime)) stop();
    }
  }

  /** Sends the page's og:image, when it has one. */
  function sendOgImage(): void {
    const ogImage = doc.querySelector<HTMLMetaElement>(
      'meta[property="og:image"], meta[name="og:image"]',
    )?.content;
    if (ogImage) send({ type: 'TAB_OG_IMAGE', payload: { ogImage } });
  }

  /**
   * Forwards media-reader's metadata to the extension.
   * @param event - The metadata event
   */
  function onMetadata(event: Event): void {
    send({ type: 'TAB_METADATA_UPDATE', payload: (event as CustomEvent).detail });
  }

  const onMessage: MessageListener = (message, _sender, sendResponse) => {
    if (stopped) return false;
    if (message.type === 'REQUEST_METADATA') {
      win.dispatchEvent(new CustomEvent(REQUEST_EVENT));
      sendResponse({ success: true });
      return true;
    }
    if (message.type === 'CONTROL_MEDIA') {
      win.dispatchEvent(new CustomEvent(CONTROL_EVENT, { detail: { action: message.action } }));
      sendResponse({ success: true });
      return true;
    }
    return false;
  };

  /** Removes every listener; safe to call more than once. */
  function stop(): void {
    if (stopped) return;
    stopped = true;
    doc.removeEventListener('DOMContentLoaded', sendOgImage);
    win.removeEventListener(METADATA_EVENT, onMetadata);
    try {
      runtime.onMessage.removeListener(onMessage);
    } catch {
      // An invalidated context may refuse even this; its listeners never fire again anyway.
    }
  }

  // Meta tags aren't there yet at document_start.
  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', sendOgImage, { once: true });
  } else {
    sendOgImage();
  }
  win.addEventListener(METADATA_EVENT, onMetadata);
  runtime.onMessage.addListener(onMessage);

  return stop;
}
