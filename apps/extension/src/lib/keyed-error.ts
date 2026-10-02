/**
 * Errors that carry an i18n key and the values its message needs.
 *
 * The background and offscreen documents report a failure to the popup as an
 * i18n key in the error's message, which the popup translates. A key alone
 * cannot fill a placeholder such as `{{max}}`, so an error that has figures to
 * report carries them here and they travel beside the key as `errorParams`.
 */

/** Interpolation values for an error message. */
export type ErrorParams = Record<string, string | number>;

/**
 * An error whose message is an i18n key, with the values that key's text needs.
 */
export class KeyedError extends Error {
  /** Interpolation values for the key's text. */
  readonly params: ErrorParams;

  /**
   * Creates the error.
   * @param key - The i18n key, used as the error's message
   * @param params - Interpolation values for the key's text
   */
  constructor(key: string, params: ErrorParams) {
    super(key);
    this.name = 'KeyedError';
    this.params = params;
  }
}

/**
 * Reads the interpolation values off a caught error.
 * @param err - Whatever was caught
 * @returns The values of a `KeyedError`, or undefined for anything else
 */
export function errorParamsOf(err: unknown): ErrorParams | undefined {
  return err instanceof KeyedError ? err.params : undefined;
}
