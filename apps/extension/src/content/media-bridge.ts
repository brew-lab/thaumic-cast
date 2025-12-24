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

  // Forward metadata updates to background
  window.addEventListener(METADATA_EVENT, ((event: CustomEvent) => {
    chrome.runtime
      .sendMessage({
        type: 'TAB_METADATA_UPDATE',
        payload: event.detail,
      })
      .catch(() => {
        // Background might be inactive or context invalidated
      });
  }) as EventListener);

  // Handle requests from background to refresh metadata
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'REQUEST_METADATA') {
      // Dispatch event to media-reader in MAIN world
      window.dispatchEvent(new CustomEvent(REQUEST_EVENT));
      sendResponse({ success: true });
      return true;
    }
    return false;
  });
})();
