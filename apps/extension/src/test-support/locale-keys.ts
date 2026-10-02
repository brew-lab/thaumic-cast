/**
 * Static checks that keep a locale file and the code that looks keys up in step.
 *
 * These read the source as text. They are cheap, and they catch the two faults
 * that showed raw keys to users: a key thrown or looked up with no entry, and
 * an entry nothing looks up. They do not prove a key is reached at run time.
 *
 * Used by the locale tests of both apps (the desktop test imports this file by
 * relative path, as it already does the extension's locale file).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';

/** Suffixes i18next adds to a key to pick the English plural form. */
const PLURAL_SUFFIX = /_(one|other)$/;

/** What a scan of an app's source found. */
export interface SourceKeyScan {
  /** Keys passed to `t('…')` as a plain string literal. */
  literalLookups: string[];
  /**
   * The fixed start of every template literal that ends in a placeholder, such
   * as `auto_stop_` from `auto_stop_${reason}`. Keys are built from these.
   */
  dynamicPrefixes: string[];
  /** All non-test source, concatenated, for searching quoted keys in. */
  text: string;
}

/**
 * Reads every non-test TypeScript file under a directory and collects the
 * locale keys it mentions.
 * @param root - The source directory to scan
 * @returns The literal lookups, the dynamic key prefixes and the source text
 */
export function scanSourceKeys(root: string): SourceKeyScan {
  const literalLookups = new Set<string>();
  const dynamicPrefixes = new Set<string>();
  let text = '';
  for (const file of new Glob('**/*.{ts,tsx}').scanSync(root)) {
    if (file.includes('.test.') || file.includes('test-support')) continue;
    const source = readFileSync(join(root, file), 'utf8');
    text += source;
    for (const match of source.matchAll(/\bt\(\s*'([^']+)'/g)) literalLookups.add(match[1]);
    for (const match of source.matchAll(/`([a-z][a-z_.]{3,})\$\{/g)) {
      if (/[_.]$/.test(match[1])) dynamicPrefixes.add(match[1]);
    }
  }
  return { literalLookups: [...literalLookups], dynamicPrefixes: [...dynamicPrefixes], text };
}

/**
 * Whether a locale file has an entry a lookup of `key` would resolve: the key
 * itself, or its plural form.
 * @param strings - The locale file
 * @param key - The key as the code passes it to `t`
 * @returns True if a string would be found
 */
export function hasEntry(strings: Record<string, string>, key: string): boolean {
  return typeof strings[key] === 'string' || typeof strings[`${key}_other`] === 'string';
}

/**
 * Lists the literal `t('…')` lookups that have no entry in the locale file.
 * @param strings - The locale file
 * @param scan - The source scan
 * @returns The keys that would show raw
 */
export function lookupsWithoutEntry(
  strings: Record<string, string>,
  scan: SourceKeyScan,
): string[] {
  return scan.literalLookups.filter((key) => !hasEntry(strings, key));
}

/**
 * Lists the locale entries no source file mentions: neither quoted in full
 * (with any plural suffix removed) nor starting with a dynamic key prefix.
 * @param strings - The locale file
 * @param scan - The source scan
 * @returns The keys nothing appears to use
 */
export function entriesWithoutReference(
  strings: Record<string, string>,
  scan: SourceKeyScan,
): string[] {
  return Object.keys(strings).filter((key) => {
    const base = key.replace(PLURAL_SUFFIX, '');
    const quoted = [key, base].some(
      (name) => scan.text.includes(`'${name}'`) || scan.text.includes(`"${name}"`),
    );
    return !quoted && !scan.dynamicPrefixes.some((prefix) => key.startsWith(prefix));
  });
}

/**
 * Collects the `error_*` keys a source file names as string literals.
 * @param path - The file to read
 * @returns The distinct keys
 */
export function errorKeysIn(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  return [...new Set([...source.matchAll(/'(error_[a-z_]+)'/g)].map((match) => match[1]))];
}

/**
 * Collects the reasons the core gives for degraded network health, which both
 * apps look up as `network.<reason>`.
 * @param repoRoot - The repository root
 * @returns The distinct reasons
 */
export function networkHealthReasons(repoRoot: string): string[] {
  const source = readFileSync(
    join(repoRoot, 'packages/thaumic-core/src/services/topology_monitor.rs'),
    'utf8',
  );
  return [
    ...new Set(
      [...source.matchAll(/Some\("(speakers_[a-z_]+)"\.to_string\(\)\)/g)].map((m) => m[1]),
    ),
  ];
}

/**
 * Lists the plural entries whose other form is missing. English needs both
 * `_one` and `_other`; with only one of them, the other count shows the raw key.
 * @param strings - The locale file
 * @returns The keys that lack their counterpart
 */
export function unpairedPlurals(strings: Record<string, string>): string[] {
  return Object.keys(strings).filter((key) => {
    const match = PLURAL_SUFFIX.exec(key);
    if (!match) return false;
    const base = key.slice(0, match.index);
    return !(`${base}_${match[1] === 'one' ? 'other' : 'one'}` in strings);
  });
}
