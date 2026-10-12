// Stands in for the Tauri bridge in a plain browser, added before the app's own scripts
// (Playwright addInitScript). @tauri-apps/api calls window.__TAURI_INTERNALS__; this answers
// every desktop command by POST /ipc/{command} to the real core (real_desktop_companion in
// thaumic-core, reached through the rig's server, so it stays same-origin under the CSP), and
// the event plugin from GET /ipc/events. What only Tauri's plugins do is answered here:
// plugin:app|version (the package version, filled in by lib.mjs), plugin:shell|open (recorded
// in window.__REALAPP_OPENED__) and plugin:log (nothing). Any other plugin call throws, so a
// new one is noticed. Checked against @tauri-apps/api 2.9 (core.js, event.js).
(() => {
  const VERSION = '__REALAPP_VERSION__';
  const callbacks = new Map();
  const listeners = new Map();
  let nextCallback = 1;
  let nextListener = 1;
  window.__REALAPP_OPENED__ = [];

  const source = new EventSource('/ipc/events');
  const open = new Promise((resolve) => source.addEventListener('open', resolve, { once: true }));
  source.addEventListener('message', (message) => {
    const { event, payload } = JSON.parse(message.data);
    for (const [id, listener] of listeners) {
      if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload });
    }
  });

  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { windowLabel: 'main', label: 'main' },
    },
    plugins: {},
    transformCallback(callback, once = false) {
      const id = nextCallback++;
      callbacks.set(
        id,
        once
          ? (value) => {
              callbacks.delete(id);
              callback?.(value);
            }
          : (value) => callback?.(value),
      );
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    convertFileSrc(path) {
      return path;
    },
    async invoke(cmd, args = {}) {
      switch (cmd) {
        case 'plugin:event|listen': {
          // Registered once the stream is open, so no event sent after listen() resolves is
          // missed, as with Tauri.
          await open;
          const id = nextListener++;
          listeners.set(id, { event: args.event, handler: args.handler });
          return id;
        }
        case 'plugin:event|unlisten':
          listeners.delete(args.eventId);
          return null;
        case 'plugin:app|version':
          return VERSION;
        case 'plugin:shell|open':
          window.__REALAPP_OPENED__.push(args);
          return null;
        default:
          break;
      }
      if (cmd.startsWith('plugin:log|')) return null;
      if (cmd.startsWith('plugin:')) throw new Error(`the rig does not answer ${cmd}`);
      const res = await fetch(`/ipc/${cmd}`, { method: 'POST', body: JSON.stringify(args) });
      const body = await res.json();
      if (!res.ok) throw body;
      return body;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(_event, id) {
      listeners.delete(id);
    },
  };
})();
