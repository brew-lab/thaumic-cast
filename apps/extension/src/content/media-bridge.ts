/**
 * Media Bridge (ISOLATED world)
 *
 * Bridge between MAIN world (media-reader) and background script.
 * Runs in ISOLATED world with chrome.runtime access.
 *
 * Responsibilities:
 * - Listen for events from media-reader
 * - Forward metadata to background via chrome.runtime
 * - Handle metadata requests from background
 * - Handle control commands from background
 * - Extract og:image from page
 *
 * Non-responsibilities:
 * - Parsing or validating data
 * - Caching
 * - Any business logic
 */

(function mediaBridgeIsolated() {
  /** Event name for metadata updates (reader -> bridge) */
  const METADATA_EVENT = '__thaumic_metadata__';

  /** Event name for metadata requests (bridge -> reader) */
  const REQUEST_EVENT = '__thaumic_request_metadata__';

  /** Event name for control commands (bridge -> reader) */
  const CONTROL_EVENT = '__thaumic_control__';

  /**
   * Extracts the Open Graph image URL from the page.
   * @returns The og:image URL or undefined
   */
  function getOgImage(): string | undefined {
    const ogMeta = document.querySelector<HTMLMetaElement>(
      'meta[property="og:image"], meta[name="og:image"]',
    );
    return ogMeta?.content || undefined;
  }

  /**
   * Sends og:image to background if found.
   */
  function sendOgImage(): void {
    const ogImage = getOgImage();
    if (ogImage) {
      chrome.runtime
        .sendMessage({
          type: 'TAB_OG_IMAGE',
          payload: { ogImage },
        })
        .catch(() => {
          // Background may not be ready
        });
    }
  }

  // Extract og:image when DOM is ready (meta tags aren't available at document_start)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sendOgImage, { once: true });
  } else {
    sendOgImage();
  }

  // Forward metadata updates to background
  window.addEventListener(METADATA_EVENT, ((event: CustomEvent) => {
    chrome.runtime
      .sendMessage({
        type: 'TAB_METADATA_UPDATE',
        payload: event.detail,
      })
      .catch(() => {
        // Background may not be ready
      });
  }) as EventListener);

  // Handle requests from background
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'REQUEST_METADATA') {
      // Dispatch event to media-reader in MAIN world
      window.dispatchEvent(new CustomEvent(REQUEST_EVENT));
      sendResponse({ success: true });
      return true;
    }

    if (message.type === 'CONTROL_MEDIA') {
      // Dispatch control command to media-reader in MAIN world
      window.dispatchEvent(
        new CustomEvent(CONTROL_EVENT, {
          detail: { action: message.action },
        }),
      );
      sendResponse({ success: true });
      return true;
    }

    return false;
  });
})();
