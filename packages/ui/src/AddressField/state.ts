/** What testing an address came to (DESIGN.md M-address). */
export type AddressResult =
  | {
      /** It answered. */
      ok: true;
      /** Server kind: the result line's words, "Thaumic Cast answered". */
      message?: string;
      /** Server kind: the latency, already worded ("12 ms"), in a tabular box. */
      detail?: string;
      /** What the Announcer says: "Thaumic Cast answered, 12 ms", "… is on the list." */
      said?: string;
    }
  | {
      /** It did not answer, or the wrong thing did. */
      ok: false;
      /** The answer, for the message slot and the Announcer. */
      error: string;
    };

/**
 * The error a field shows: a validation message wins (P-forms), then a failed request's
 * answer. A failed request is not a validation error, so only the first sets `aria-invalid`.
 * @param invalid - The validation message, if the address cannot be right
 * @param result - The last test's result, if any
 * @returns The message for the slot, or undefined for none
 */
export function shownError(
  invalid: string | undefined,
  result: AddressResult | null,
): string | undefined {
  if (invalid) return invalid;
  if (result && !result.ok) return result.error;
  return undefined;
}
