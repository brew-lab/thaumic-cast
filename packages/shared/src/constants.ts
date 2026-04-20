/**
 * Cross-cutting constants shared between the extension, desktop app, and server UIs.
 */

/**
 * Canonical GitHub releases page — the single update destination for users who need
 * to grab a newer desktop app or server build. Keep hardcoded and literal so no
 * remote resolution is ever required (PRIVACY.md relies on this).
 */
export const GITHUB_RELEASES_URL = 'https://github.com/brew-lab/thaumic-cast/releases/latest';

/**
 * Minimum wire-protocol semver the extension requires from the companion
 * (desktop app or headless server) to stream without known-broken behaviour.
 * If an older companion reports a version below this, the extension surfaces
 * a dismissible "update" prompt in the popup.
 *
 * See `CONTRIBUTING.md` → Protocol versioning for when and how to bump this;
 * the policy lives there so it can't drift from this comment.
 */
export const MIN_COMPATIBLE_PROTOCOL_VERSION = '0.4.0';
