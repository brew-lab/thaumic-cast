/**
 * Syncs version numbers from each app/package's `package.json` into the other
 * places the same version is declared. Invoked at release time by
 * `bun run changeset:version` so released artifacts always agree on version.
 *
 * Syncs performed:
 * - Desktop: `package.json` → `tauri.conf.json`, `Cargo.toml`
 * - Extension: `package.json` → `manifest.json`
 * - Server: `package.json` → `Cargo.toml`
 * - Core: `package.json` → `Cargo.toml`
 * - Protocol: `package.json` → `websocket.ts`, `protocol_constants.rs`
 *
 * Failure policy: if any regex-based sync can't locate the target declaration
 * (e.g. the syntax was refactored without updating the regex here), the script
 * throws rather than warning-and-continuing. The release pipeline will fail
 * loudly rather than ship drifted versions silently.
 *
 * @module sync-versions
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Matches the `version = "…"` declaration in a Cargo.toml `[package]` section. */
const CARGO_VERSION_REGEX = /^(version\s*=\s*")([^"]+)(")/m;

/**
 * Matches the `PROTOCOL_VERSION` constant exported from `@thaumic-cast/protocol`.
 * Quote-agnostic: accepts either single or double quotes so the match keeps
 * working if Prettier config flips quote style. The second capture group is
 * the opening quote, which is reused on replace (via `$2`) to preserve style.
 */
const TS_PROTOCOL_VERSION_REGEX =
  /^(export const PROTOCOL_VERSION = )(['"])([^'"]+)\2( as const;)/m;

/** Matches the `PROTOCOL_VERSION` constant in `thaumic-core`'s `protocol_constants.rs`. */
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
 * Syncs a single `target` version into `filePath` by matching `regex` and
 * rewriting with `replaceTemplate`. Throws if the regex does not match, so
 * release-time callers can fail fast rather than ship drifted versions.
 *
 * @param options - File/regex/label configuration for this sync
 * @param options.filePath - Absolute path to the file to update
 * @param options.regex - Regex that matches the version declaration
 * @param options.versionGroup - 1-indexed capture group that holds the current version
 * @param options.replaceTemplate - `String.replace` template used with `regex`
 *   (e.g. `'$1<new>$3'`). Interpolate the target version into this string.
 * @param options.target - Desired version (drives `replaceTemplate`)
 * @param options.label - Human-readable label for logs and error messages
 */
function syncRegexFile(options: {
  filePath: string;
  regex: RegExp;
  versionGroup: number;
  replaceTemplate: string;
  target: string;
  label: string;
}): void {
  const { filePath, regex, versionGroup, replaceTemplate, target, label } = options;
  const content = readFileSync(filePath, 'utf-8');
  const match = content.match(regex);
  if (!match) {
    throw new Error(
      `${label}: version declaration not found. ` +
        `If the declaration syntax changed, update the matching regex in scripts/sync-versions.ts.`,
    );
  }
  const current = match[versionGroup];
  if (current !== target) {
    console.log(`${label}: ${current} -> ${target}`);
    writeFileSync(filePath, content.replace(regex, replaceTemplate));
  } else {
    console.log(`${label}: ${target} (no change)`);
  }
}

/**
 * Cargo-specific convenience wrapper around `syncRegexFile`.
 *
 * @param filePath - Absolute path to the `Cargo.toml` to update
 * @param target - Version string to write into the `[package].version` field
 * @param label - Human-readable label for logs and error messages
 */
function syncCargoVersion(filePath: string, target: string, label: string): void {
  syncRegexFile({
    filePath,
    regex: CARGO_VERSION_REGEX,
    versionGroup: 2,
    replaceTemplate: `$1${target}$3`,
    target,
    label,
  });
}

/**
 * Syncs the desktop app version from `package.json` to `tauri.conf.json`
 * and `Cargo.toml`.
 */
function syncDesktopVersion(): void {
  const pkgPath = join(ROOT, 'apps/desktop/package.json');
  const tauriPath = join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json');
  const cargoPath = join(ROOT, 'apps/desktop/src-tauri/Cargo.toml');

  const pkg = readJson<PackageJson>(pkgPath);
  const tauri = readJson<TauriConfig>(tauriPath);

  if (tauri.version !== pkg.version) {
    console.log(`desktop (tauri.conf.json): ${tauri.version} -> ${pkg.version}`);
    tauri.version = pkg.version;
    writeJson(tauriPath, tauri);
  } else {
    console.log(`desktop (tauri.conf.json): ${pkg.version} (no change)`);
  }

  syncCargoVersion(cargoPath, pkg.version, 'desktop (Cargo.toml)');
}

/** Syncs the extension version from `package.json` to `manifest.json`. */
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

/** Syncs the thaumic-core version from `package.json` to `Cargo.toml`. */
function syncCoreVersion(): void {
  const pkg = readJson<PackageJson>(join(ROOT, 'packages/thaumic-core/package.json'));
  syncCargoVersion(
    join(ROOT, 'packages/thaumic-core/Cargo.toml'),
    pkg.version,
    'thaumic-core (Cargo.toml)',
  );
}

/** Syncs the headless-server version from `package.json` to `Cargo.toml`. */
function syncServerVersion(): void {
  const pkg = readJson<PackageJson>(join(ROOT, 'apps/server/package.json'));
  syncCargoVersion(join(ROOT, 'apps/server/Cargo.toml'), pkg.version, 'server (Cargo.toml)');
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
  const pkg = readJson<PackageJson>(join(ROOT, 'packages/protocol/package.json'));
  const target = pkg.version;

  // TS regex capture groups: $1 = prefix, $2 = opening quote, $3 = version,
  // $4 = suffix. Replace reuses $2 for both quotes to preserve the file's
  // existing style (single or double).
  syncRegexFile({
    filePath: join(ROOT, 'packages/protocol/src/websocket.ts'),
    regex: TS_PROTOCOL_VERSION_REGEX,
    versionGroup: 3,
    replaceTemplate: `$1$2${target}$2$4`,
    target,
    label: 'protocol (websocket.ts)',
  });

  syncRegexFile({
    filePath: join(ROOT, 'packages/thaumic-core/src/protocol_constants.rs'),
    regex: RUST_PROTOCOL_VERSION_REGEX,
    versionGroup: 2,
    replaceTemplate: `$1${target}$3`,
    target,
    label: 'protocol (protocol_constants.rs)',
  });
}

// Main execution — wrap in try/catch so CI output is one clean error line
// instead of a stack trace, while still exiting non-zero.
try {
  console.log('Syncing versions...');
  syncDesktopVersion();
  syncExtensionVersion();
  syncServerVersion();
  syncCoreVersion();
  syncProtocolVersion();
  console.log('Done.');
} catch (err) {
  console.error(`sync-versions failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
