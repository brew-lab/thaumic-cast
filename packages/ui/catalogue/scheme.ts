import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

/** The colour scheme a specimen is drawn in. */
export type Scheme = 'light' | 'dark';

/** Provides the scheme of the panel a specimen sits in. */
export const SchemeContext = createContext<Scheme>('light');

/**
 * Returns the scheme of the panel the specimen sits in.
 * @returns The panel's colour scheme
 */
export function useScheme(): Scheme {
  return useContext(SchemeContext);
}
