/**
 * Syncs version numbers from package.json to native config files.
 *
 * This script ensures that version numbers stay consistent across:
 * - Desktop: package.json -> tauri.conf.json
 * - Extension: package.json -> manifest.json
 *
 * @module sync-versions
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/** Minimal package.json structure for version extraction. */
interface PackageJson {
  version: string;
}

/** Tauri configuration file structure. */
interface TauriConfig {
  version: string;
  [key: string]: unknown;
}

/** Chrome extension manifest structure. */
interface ManifestJson {
  version: string;
  [key: string]: unknown;
}

/**
 * Reads and parses a JSON file from the filesystem.
 *
 * @param filePath - Absolute path to the JSON file
 * @returns Parsed JSON content
 * @template T - Expected shape of the JSON content
 */
function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
}

/**
 * Writes data to a JSON file with consistent formatting.
 *
 * @param filePath - Absolute path to the output file
 * @param data - Data to serialize and write
 */
function writeJson(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Syncs the desktop app version from package.json to tauri.conf.json.
 * Logs the version change or indicates no change was needed.
 */
function syncDesktopVersion(): void {
  const pkgPath = join(ROOT, 'apps/desktop/package.json');
  const tauriPath = join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json');

  const pkg = readJson<PackageJson>(pkgPath);
  const tauri = readJson<TauriConfig>(tauriPath);

  if (tauri.version !== pkg.version) {
    console.log(`desktop: ${tauri.version} -> ${pkg.version}`);
    tauri.version = pkg.version;
    writeJson(tauriPath, tauri);
  } else {
    console.log(`desktop: ${pkg.version} (no change)`);
  }
}

/**
 * Syncs the extension version from package.json to manifest.json.
 * Logs the version change or indicates no change was needed.
 */
function syncExtensionVersion(): void {
  const pkgPath = join(ROOT, 'apps/extension/package.json');
  const manifestPath = join(ROOT, 'apps/extension/manifest.json');

  const pkg = readJson<PackageJson>(pkgPath);
  const manifest = readJson<ManifestJson>(manifestPath);

  if (manifest.version !== pkg.version) {
    console.log(`extension: ${manifest.version} -> ${pkg.version}`);
    manifest.version = pkg.version;
    writeJson(manifestPath, manifest);
  } else {
    console.log(`extension: ${pkg.version} (no change)`);
  }
}

// Main execution
console.log('Syncing versions...');
syncDesktopVersion();
syncExtensionVersion();
console.log('Done.');
