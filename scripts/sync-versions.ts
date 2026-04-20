/**
 * Syncs version numbers from package.json to native config files.
 *
 * This script ensures that version numbers stay consistent across:
 * - Desktop: package.json -> tauri.conf.json, Cargo.toml
 * - Extension: package.json -> manifest.json
 * - Server: package.json -> Cargo.toml
 * - Core: package.json -> Cargo.toml
 *
 * @module sync-versions
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Regex to match version in Cargo.toml [package] section. */
const CARGO_VERSION_REGEX = /^(version\s*=\s*")([^"]+)(")/m;

/**
 * Regex to match the `PROTOCOL_VERSION` constant exported from
 * `@thaumic-cast/protocol`. Quote-agnostic: accepts either single or double
 * quotes so the match keeps working if Prettier config flips quote style. The
 * second capture group is the opening quote, which we reuse on replace to
 * preserve the file's existing style.
 */
const TS_PROTOCOL_VERSION_REGEX =
  /^(export const PROTOCOL_VERSION = )(['"])([^'"]+)\2( as const;)/m;

/** Regex to match the `PROTOCOL_VERSION` constant in `thaumic-core`'s `protocol_constants.rs`. */
const RUST_PROTOCOL_VERSION_REGEX = /^(pub const PROTOCOL_VERSION: &str = ")([^"]+)(";)/m;

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
 * Syncs the desktop app version from package.json to tauri.conf.json and Cargo.toml.
 * Logs the version change or indicates no change was needed.
 */
function syncDesktopVersion(): void {
  const pkgPath = join(ROOT, 'apps/desktop/package.json');
  const tauriPath = join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json');
  const cargoPath = join(ROOT, 'apps/desktop/src-tauri/Cargo.toml');

  const pkg = readJson<PackageJson>(pkgPath);
  const tauri = readJson<TauriConfig>(tauriPath);

  // Sync tauri.conf.json
  if (tauri.version !== pkg.version) {
    console.log(`desktop (tauri.conf.json): ${tauri.version} -> ${pkg.version}`);
    tauri.version = pkg.version;
    writeJson(tauriPath, tauri);
  } else {
    console.log(`desktop (tauri.conf.json): ${pkg.version} (no change)`);
  }

  // Sync Cargo.toml
  const cargoContent = readFileSync(cargoPath, 'utf-8');
  const cargoMatch = cargoContent.match(CARGO_VERSION_REGEX);
  if (cargoMatch) {
    const currentVersion = cargoMatch[2];
    if (currentVersion !== pkg.version) {
      console.log(`desktop (Cargo.toml): ${currentVersion} -> ${pkg.version}`);
      const updatedCargo = cargoContent.replace(CARGO_VERSION_REGEX, `$1${pkg.version}$3`);
      writeFileSync(cargoPath, updatedCargo);
    } else {
      console.log(`desktop (Cargo.toml): ${pkg.version} (no change)`);
    }
  } else {
    throw new Error(
      'desktop (Cargo.toml): [package] version declaration not found. ' +
        'If the declaration syntax changed, update CARGO_VERSION_REGEX in scripts/sync-versions.ts.',
    );
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

/**
 * Syncs the thaumic-core version from package.json to Cargo.toml.
 */
function syncCoreVersion(): void {
  const pkgPath = join(ROOT, 'packages/thaumic-core/package.json');
  const cargoPath = join(ROOT, 'packages/thaumic-core/Cargo.toml');

  const pkg = readJson<PackageJson>(pkgPath);
  const cargoContent = readFileSync(cargoPath, 'utf-8');
  const cargoMatch = cargoContent.match(CARGO_VERSION_REGEX);

  if (cargoMatch) {
    const currentVersion = cargoMatch[2];
    if (currentVersion !== pkg.version) {
      console.log(`thaumic-core (Cargo.toml): ${currentVersion} -> ${pkg.version}`);
      const updatedCargo = cargoContent.replace(CARGO_VERSION_REGEX, `$1${pkg.version}$3`);
      writeFileSync(cargoPath, updatedCargo);
    } else {
      console.log(`thaumic-core (Cargo.toml): ${pkg.version} (no change)`);
    }
  } else {
    throw new Error(
      'thaumic-core (Cargo.toml): [package] version declaration not found. ' +
        'If the declaration syntax changed, update CARGO_VERSION_REGEX in scripts/sync-versions.ts.',
    );
  }
}

/**
 * Syncs the server version from package.json to Cargo.toml.
 * This ensures the server binary version stays in sync with the product version.
 */
function syncServerVersion(): void {
  const pkgPath = join(ROOT, 'apps/server/package.json');
  const cargoPath = join(ROOT, 'apps/server/Cargo.toml');

  const pkg = readJson<PackageJson>(pkgPath);
  const cargoContent = readFileSync(cargoPath, 'utf-8');
  const cargoMatch = cargoContent.match(CARGO_VERSION_REGEX);

  if (cargoMatch) {
    const currentVersion = cargoMatch[2];
    if (currentVersion !== pkg.version) {
      console.log(`server (Cargo.toml): ${currentVersion} -> ${pkg.version}`);
      const updatedCargo = cargoContent.replace(CARGO_VERSION_REGEX, `$1${pkg.version}$3`);
      writeFileSync(cargoPath, updatedCargo);
    } else {
      console.log(`server (Cargo.toml): ${pkg.version} (no change)`);
    }
  } else {
    throw new Error(
      'server (Cargo.toml): [package] version declaration not found. ' +
        'If the declaration syntax changed, update CARGO_VERSION_REGEX in scripts/sync-versions.ts.',
    );
  }
}

/**
 * Syncs the wire-protocol version from `packages/protocol/package.json` to the
 * two places it is hard-coded:
 *
 * - `packages/protocol/src/websocket.ts` — `PROTOCOL_VERSION` constant the
 *   extension embeds in its `About` surface and `MIN_COMPATIBLE_PROTOCOL_VERSION`
 *   comparison.
 * - `packages/thaumic-core/src/protocol_constants.rs` — `PROTOCOL_VERSION`
 *   the companion emits in the WebSocket handshake ACK.
 *
 * Rust and TS must report the same value; drift would cause the out-of-date
 * warning to either miss a real mismatch or misfire against a matching build.
 * See `CONTRIBUTING.md` → Protocol versioning.
 */
function syncProtocolVersion(): void {
  const pkgPath = join(ROOT, 'packages/protocol/package.json');
  const tsPath = join(ROOT, 'packages/protocol/src/websocket.ts');
  const rustPath = join(ROOT, 'packages/thaumic-core/src/protocol_constants.rs');

  const pkg = readJson<PackageJson>(pkgPath);
  const target = pkg.version;

  // Sync TS constant. Capture groups for TS_PROTOCOL_VERSION_REGEX:
  //   $1 = `export const PROTOCOL_VERSION = `, $2 = opening quote (' or "),
  //   $3 = current version, $4 = ` as const;`
  const tsContent = readFileSync(tsPath, 'utf-8');
  const tsMatch = tsContent.match(TS_PROTOCOL_VERSION_REGEX);
  if (!tsMatch) {
    // Release-path failure: refuse to continue rather than ship stale constants.
    throw new Error(
      `protocol (websocket.ts): PROTOCOL_VERSION declaration not found. ` +
        `If the declaration syntax changed, update TS_PROTOCOL_VERSION_REGEX.`,
    );
  }
  const tsCurrent = tsMatch[3];
  if (tsCurrent !== target) {
    console.log(`protocol (websocket.ts): ${tsCurrent} -> ${target}`);
    const updated = tsContent.replace(TS_PROTOCOL_VERSION_REGEX, `$1$2${target}$2$4`);
    writeFileSync(tsPath, updated);
  } else {
    console.log(`protocol (websocket.ts): ${target} (no change)`);
  }

  // Sync Rust constant
  const rustContent = readFileSync(rustPath, 'utf-8');
  const rustMatch = rustContent.match(RUST_PROTOCOL_VERSION_REGEX);
  if (!rustMatch) {
    throw new Error(
      `protocol (protocol_constants.rs): PROTOCOL_VERSION declaration not found. ` +
        `If the declaration syntax changed, update RUST_PROTOCOL_VERSION_REGEX.`,
    );
  }
  const rustCurrent = rustMatch[2];
  if (rustCurrent !== target) {
    console.log(`protocol (protocol_constants.rs): ${rustCurrent} -> ${target}`);
    const updated = rustContent.replace(RUST_PROTOCOL_VERSION_REGEX, `$1${target}$3`);
    writeFileSync(rustPath, updated);
  } else {
    console.log(`protocol (protocol_constants.rs): ${target} (no change)`);
  }
}

// Main execution
console.log('Syncing versions...');
syncDesktopVersion();
syncExtensionVersion();
syncServerVersion();
syncCoreVersion();
syncProtocolVersion();
console.log('Done.');
