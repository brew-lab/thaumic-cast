/**
 * Video sync hook, MAIN-world entry. Built as a standalone IIFE
 * (`video-sync-hook.js`) and registered with chrome.scripting at
 * document_start in every frame, only while video sync is on.
 *
 * Installs the audio-lead hook once per page and carries the MAIN half of
 * the bridge to the relay (see protocol.ts). Until the extension sends a
 * command the hook is inert: it follows and caches the page's audio so a
 * lead can apply at once when a cast starts, and changes nothing native.
 */

import { installHook } from './install';
import {
  HELLO_HOOK_EVENT,
  HELLO_RELAY_EVENT,
  BRIDGE_VERSION,
  commandEventName,
  isNonce,
  parseJson,
  statusEventName,
  validateCommand,
} from './protocol';

const INSTALLED = '__tcvs_installed__';

(function start(G: Window & typeof globalThis): void {
  if ((G as unknown as Record<string, unknown>)[INSTALLED]) return;
  try {
    Object.defineProperty(G, INSTALLED, { value: true });
  } catch {
    return;
  }
  // Natives taken before any page script runs.
  const nAEL = G.EventTarget.prototype.addEventListener;
  const nREL = G.EventTarget.prototype.removeEventListener;
  const nDispatch = G.EventTarget.prototype.dispatchEvent;
  const NCustomEvent = G.CustomEvent;
  const nParse = JSON.parse;
  const nStringify = JSON.stringify;
  const detailGet = Object.getOwnPropertyDescriptor(G.CustomEvent.prototype, 'detail')?.get;
  const detailOf = (e: Event): unknown => (detailGet ? detailGet.call(e) : undefined);

  const hook = installHook(G);

  let nonce: string | null = null;
  const onCommand = (e: Event): void => {
    if (!nonce) return;
    const c = validateCommand(parseJson(detailOf(e), nParse), nonce);
    if (!c) return;
    if (c.op === 'set') hook.setLead(c.enabled, c.leadMs);
    else hook.rearm();
  };
  const onHello = (e: Event): void => {
    if (nonce) return;
    const n = detailOf(e);
    if (!isNonce(n)) return;
    nonce = n;
    nREL.call(G, HELLO_RELAY_EVENT, onHello);
    nAEL.call(G, commandEventName(n), onCommand);
    const statusName = statusEventName(n);
    hook.onStatus((status) => {
      const detail = nStringify({ v: BRIDGE_VERSION, nonce: n, status });
      nDispatch.call(G, new NCustomEvent(statusName, { detail }));
    });
    // The first status tells the relay the pairing is done.
    const detail = nStringify({ v: BRIDGE_VERSION, nonce: n, status: hook.status() });
    nDispatch.call(G, new NCustomEvent(statusName, { detail }));
  };
  nAEL.call(G, HELLO_RELAY_EVENT, onHello);
  nDispatch.call(G, new NCustomEvent(HELLO_HOOK_EVENT));
})(window);
