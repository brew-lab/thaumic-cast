/**
 * Video sync relay, ISOLATED-world entry. Built as a standalone IIFE
 * (`video-sync-relay.js`) and registered with chrome.scripting at
 * document_start in every frame, beside the hook, only while video sync is on.
 *
 * Pairs with the hook (see protocol.ts), passes the background's lead
 * commands to it, re-sending the current one every two seconds as the
 * heartbeat the hook's dead-man switch listens for, and passes the hook's
 * validated status back. It stays silent towards the extension until the
 * background has sent it a command, so pages that are not being cast never
 * wake the service worker. Once the extension is gone (reloaded, disabled or
 * updated) it stops re-sending, and the hook takes the lead off by itself.
 */

import {
  BRIDGE_VERSION,
  HELLO_HOOK_EVENT,
  HELLO_RELAY_EVENT,
  HOOK_STATUS_MESSAGE_TYPE,
  RESEND_MS,
  commandEventName,
  makeNonce,
  parseJson,
  statusEventName,
  validateLeadMessage,
  validateStatusMessage,
  type HookCommand,
  type HookStatus,
  type LeadMessage,
} from './protocol';

(function start(): void {
  const nonce = makeNonce();
  const cmdName = commandEventName(nonce);
  let paired = false;
  let status: HookStatus | null = null;
  let current: LeadMessage | null = null;
  let forwardedKey: string | null = null;
  let lastDriven = false;
  let timer = 0;

  /**
   * Whether this content script still belongs to a live extension.
   * @returns False once the extension was reloaded, disabled or removed
   */
  const alive = (): boolean => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = 0;
  };

  /**
   * Sends a command to the hook.
   * @param c - The command, without version and nonce
   */
  const toHook = (
    c: { op: 'set'; enabled: boolean; leadMs: number } | { op: HookCommand['op'] & 'rearm' },
  ): void => {
    if (!paired) return;
    const detail = JSON.stringify({ v: BRIDGE_VERSION, nonce, ...c });
    window.dispatchEvent(new CustomEvent(cmdName, { detail }));
  };

  /**
   * Whether the background still drives this frame: a lead is wanted, or
   * one is still in force on its way off.
   * @returns True while statuses should go to the background
   */
  const driven = (): boolean =>
    !!current && (current.enabled || (status !== null && status.appliedLeadMs > 0));

  /** Re-sends the current lead to the hook; idles once the lead is off. */
  const resend = (): void => {
    if (!alive()) {
      stop();
      return;
    }
    if (current) toHook({ op: 'set', enabled: current.enabled, leadMs: current.leadMs });
    if (!driven()) stop();
  };

  /** Passes the hook's status to the background when it changed. */
  const forward = (): void => {
    if (!current || !status || !alive()) return;
    // Once the lead is off, report that once and then stay quiet.
    const d = driven();
    if (!d && !lastDriven && forwardedKey !== null) return;
    const key = JSON.stringify(status);
    if (key === forwardedKey) return;
    forwardedKey = key;
    lastDriven = d;
    try {
      chrome.runtime.sendMessage({ type: HOOK_STATUS_MESSAGE_TYPE, status }).catch(() => {});
    } catch {
      stop();
    }
  };

  const onStatus = (e: Event): void => {
    const s = validateStatusMessage(parseJson((e as CustomEvent<unknown>).detail), nonce);
    if (!s) return;
    if (!paired) {
      paired = true;
      window.removeEventListener(HELLO_HOOK_EVENT, onHookHello);
      resend();
    }
    status = s;
    forward();
  };
  const sendHello = (): void => {
    window.dispatchEvent(new CustomEvent(HELLO_RELAY_EVENT, { detail: nonce }));
  };
  const onHookHello = (): void => {
    if (!paired) sendHello();
  };

  window.addEventListener(statusEventName(nonce), onStatus);
  window.addEventListener(HELLO_HOOK_EVENT, onHookHello);
  sendHello();

  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    const lead = validateLeadMessage(msg);
    if (!lead) return false;
    current = lead;
    resend();
    if (lead.rearm) toHook({ op: 'rearm' });
    if (!timer && driven()) timer = window.setInterval(resend, RESEND_MS);
    forwardedKey = null; // report this frame's status afresh to whoever now drives it
    forward();
    sendResponse({ paired, status });
    return false;
  });
})();
