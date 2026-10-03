/**
 * Copying text that is still being worked out when the user clicks.
 *
 * WebKit (the webview on macOS and Linux) lets a page write to the clipboard
 * only during the user's click, and any await, such as a Tauri call, ends that
 * window. So the write has to start inside the click handler, before anything
 * is awaited. `ClipboardItem` takes a promise for its contents for exactly this
 * case: the write starts now and the text follows when it is ready.
 */

/** The parts of the browser this module uses, passed in so it can be tested. */
export interface ClipboardEnv {
  /** The async clipboard. */
  clipboard: Pick<Clipboard, 'write' | 'writeText'>;
  /** The `ClipboardItem` constructor, or undefined where there is none. */
  ClipboardItem?: typeof ClipboardItem;
}

/**
 * The browser's own clipboard and `ClipboardItem`.
 * @returns The environment to copy with
 */
export function browserClipboard(): ClipboardEnv {
  return {
    clipboard: navigator.clipboard,
    ClipboardItem: typeof ClipboardItem === 'undefined' ? undefined : ClipboardItem,
  };
}

/**
 * Copies text that is not known yet. Call it straight from the click handler,
 * before any await, so the clipboard write starts inside the user's click.
 *
 * Where `ClipboardItem` exists, its promise-valued form is used, which WebKit
 * accepts after the click has ended. If that is refused (some engines do not
 * take a promise), or there is no `ClipboardItem`, the text is awaited and
 * written with `writeText`, which Chromium allows outside the click.
 * @param pending - The text to copy; a rejection means there is nothing to copy
 * @param env - The clipboard to write to
 * @returns Resolves once copied; rejects if the clipboard refused or `pending` rejected
 */
export function copyPendingText(
  pending: Promise<string>,
  env: ClipboardEnv = browserClipboard(),
): Promise<void> {
  const writeLater = async (): Promise<void> => env.clipboard.writeText(await pending);
  const Item = env.ClipboardItem;
  if (!Item) return writeLater();

  let started: Promise<void>;
  try {
    const blob = pending.then((text) => new Blob([text], { type: 'text/plain' }));
    // A rejection here also rejects the write; don't report it twice.
    blob.catch(() => {});
    started = env.clipboard.write([new Item({ 'text/plain': blob })]);
  } catch (error) {
    started = Promise.reject(error);
  }
  return started.catch(writeLater);
}
