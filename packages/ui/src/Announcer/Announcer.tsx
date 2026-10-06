import { createContext, type ComponentChildren, type JSX } from 'preact';
import { useContext, useEffect, useMemo, useRef } from 'preact/hooks';
import { createLogger } from '@thaumic-cast/shared';
import { createAnnouncer, type Announcer, type AnnouncerController } from './createAnnouncer';

const log = createLogger('Announcer');

const AnnouncerContext = createContext<Announcer | null>(null);

let mountedProviders = 0;

/** Props for {@link AnnouncerProvider}. */
export interface AnnouncerProviderProps {
  /** The surface. */
  children: ComponentChildren;
}

/**
 * The one live region per surface (DESIGN.md A-announcer): mount it once, at the root of the
 * popup, the options page or the desktop shell. It renders two visually hidden regions at the
 * end of the surface, polite (`role="status"`) and assertive (`role="alert"`), and nothing is
 * said while the surface opens. Components never render `aria-live` or `role="alert"`
 * themselves; they call `useAnnouncer().say()`.
 * @param props - Component props
 * @param props.children - The surface
 * @returns The surface followed by the two regions
 */
export function AnnouncerProvider({ children }: AnnouncerProviderProps): JSX.Element {
  const polite = useRef<HTMLDivElement>(null);
  const assertive = useRef<HTMLDivElement>(null);
  const controller = useRef<AnnouncerController | null>(null);

  const api = useMemo<Announcer>(
    () => ({
      say: (message, options) => controller.current?.say(message, options),
    }),
    [],
  );

  useEffect(() => {
    mountedProviders += 1;
    if (mountedProviders > 1) {
      log.warn('More than one AnnouncerProvider is mounted; mount one per surface.');
    }
    if (!polite.current || !assertive.current) return undefined;
    const announcer = createAnnouncer({ polite: polite.current, assertive: assertive.current });
    controller.current = announcer;
    // Open a frame after mounting, so what is on screen at open is never read out.
    const frame = requestAnimationFrame(() => announcer.open());
    return () => {
      mountedProviders -= 1;
      cancelAnimationFrame(frame);
      announcer.close();
      controller.current = null;
    };
  }, []);

  return (
    <AnnouncerContext.Provider value={api}>
      {children}
      <div ref={polite} role="status" class="visually-hidden" />
      <div ref={assertive} role="alert" class="visually-hidden" />
    </AnnouncerContext.Provider>
  );
}

const silent: Announcer = {
  say: () => {
    log.warn('useAnnouncer() was called outside an AnnouncerProvider; nothing was said.');
  },
};

/**
 * Returns the surface's announcer. `say(message, { key, urgent })` says a message once:
 * `key` dedupes for the life of the surface, and `urgent` is only for a danger banner after
 * open, a room's failure line and a CastBar failure.
 * @returns The announcer
 */
export function useAnnouncer(): Announcer {
  return useContext(AnnouncerContext) ?? silent;
}
