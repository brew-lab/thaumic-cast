import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';

/**
 * Scrolls to an element matching the current URL hash.
 * Wouter doesn't handle hash scrolling automatically, so this provides that behavior.
 */
function scrollToHash(): void {
  const { hash } = window.location;
  if (!hash) return;

  const id = hash.slice(1);
  const element = document.getElementById(id);
  if (!element) return;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth' });
}

/**
 * Hook that automatically scrolls to hash targets on navigation.
 *
 * Since wouter handles client-side routing without native browser navigation,
 * hash-based scrolling (e.g., `/settings#speakers`) doesn't work by default.
 * This hook restores that behavior app-wide.
 *
 * Should be called once at the app root level.
 */
export function useHashScroll(): void {
  const [location] = useLocation();
  const [hash, setHash] = useState(window.location.hash);

  // Listen for hash changes (handles same-path hash navigation)
  useEffect(() => {
    const handleHashChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // Update hash state when location changes (handles cross-path navigation)
  useEffect(() => {
    setHash(window.location.hash);
  }, [location]);

  // Scroll to hash target when hash or location changes
  useEffect(() => {
    if (!hash) return;
    // Wait for browser paint to ensure DOM is ready
    const raf = requestAnimationFrame(scrollToHash);
    return () => cancelAnimationFrame(raf);
  }, [hash, location]);
}
