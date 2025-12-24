import { useState, useCallback } from 'preact/hooks';

/**
 * Status of a button action.
 */
export type ButtonActionStatus = 'idle' | 'loading' | 'success' | 'error';

/**
 * State returned by useButtonAction hook.
 */
export interface ButtonActionState {
  /** Current status of the action */
  status: ButtonActionStatus;
  /** Error message if status is 'error' */
  error?: string;
  /** Whether the button should be disabled */
  isDisabled: boolean;
}

/**
 * Hook for managing async button action states.
 *
 * Provides a state machine: idle → loading → success/error → idle
 *
 * @param action - Async function to execute on button click
 * @param options - Configuration options
 * @param options.successDuration
 * @param options.errorDuration
 * @returns State object and execute function
 *
 * @example
 * ```tsx
 * const { status, execute, isDisabled } = useButtonAction(
 *   () => restartServer(),
 *   { successDuration: 2000 }
 * );
 *
 * <Button onClick={execute} disabled={isDisabled}>
 *   {status === 'loading' ? 'Restarting...' : 'Restart'}
 * </Button>
 * ```
 */
export function useButtonAction(
  action: () => Promise<void>,
  options: {
    /** How long to show success state (ms). Default: 2000 */
    successDuration?: number;
    /** How long to show error state (ms). Default: 3000 */
    errorDuration?: number;
  } = {},
): ButtonActionState & { execute: () => Promise<void> } {
  const { successDuration = 2000, errorDuration = 3000 } = options;

  const [status, setStatus] = useState<ButtonActionStatus>('idle');
  const [error, setError] = useState<string | undefined>();

  const execute = useCallback(async () => {
    if (status === 'loading') return;

    setStatus('loading');
    setError(undefined);

    try {
      await action();
      setStatus('success');
      setTimeout(() => setStatus('idle'), successDuration);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'An error occurred';
      setError(message);
      setStatus('error');
      setTimeout(() => {
        setStatus('idle');
        setError(undefined);
      }, errorDuration);
    }
  }, [action, status, successDuration, errorDuration]);

  return {
    status,
    error,
    isDisabled: status === 'loading',
    execute,
  };
}
