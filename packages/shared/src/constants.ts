/**
 * Cross-cutting constants shared between the extension, desktop app, and server UIs.
 */

/**
 * The website's download page: the single destination for users who need the desktop
 * app, the server, the extension zip, or a newer version of any of them. Keep hardcoded
 * and literal so no remote resolution is ever required (PRIVACY.md relies on this).
 */
export const DOWNLOAD_URL = 'https://www.thaumiccast.com/download/';

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
