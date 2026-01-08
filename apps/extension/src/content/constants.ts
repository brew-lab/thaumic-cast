/**
 * Shared constants for content scripts.
 *
 * These event names are used for communication between
 * MAIN world (media-reader) and ISOLATED world (media-bridge).
 */

/** Event name for metadata updates (reader -> bridge) */
export const METADATA_EVENT = '__thaumic_metadata__';

/** Event name for metadata requests (bridge -> reader) */
export const REQUEST_EVENT = '__thaumic_request_metadata__';

/** Event name for control commands (bridge -> reader) */
export const CONTROL_EVENT = '__thaumic_control__';
