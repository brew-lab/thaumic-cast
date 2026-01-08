import { useRef, useEffect } from 'preact/hooks';

/**
 * Hook that tracks whether the component is mounted.
 *
 * Useful for preventing state updates after unmount in async operations.
 * The ref is automatically set to true on mount and false on unmount.
 *
 * @returns A ref object where .current is true while mounted
 *
 * @example
 * const mountedRef = useMountedRef();
 *
 * useEffect(() => {
 *   async function fetchData() {
 *     const data = await api.fetch();
 *     if (mountedRef.current) {
 *       setState(data);
 *     }
 *   }
 *   fetchData();
 * }, []);
 */
export function useMountedRef(): { readonly current: boolean } {
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return mountedRef;
}
