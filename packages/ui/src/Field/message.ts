/** What a Field's message slot holds. */
export type FieldMessage = 'error' | 'status' | 'help' | null;

/**
 * Picks what the one message slot under a control shows (DESIGN.md M-field, F-shift): the
 * error replaces the status, and the status replaces the help.
 * @param parts - What the field has
 * @param parts.help - The help line
 * @param parts.status - A result that takes the help's place
 * @param parts.error - The error
 * @returns The part to show, or null for an empty slot
 */
export function fieldMessage({
  help,
  status,
  error,
}: {
  help?: unknown;
  status?: unknown;
  error?: string;
}): FieldMessage {
  if (error) return 'error';
  if (status !== undefined && status !== null && status !== false && status !== '') {
    return 'status';
  }
  if (help !== undefined && help !== null && help !== false && help !== '') return 'help';
  return null;
}
