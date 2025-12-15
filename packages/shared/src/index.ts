/**
 * @thaumic-cast/shared
 *
 * Re-exports generated types from @thaumic-cast/protocol plus hand-written utilities:
 * - api.ts: Type re-exports + validation helpers (isValidIPv4, isValidUrl)
 * - events.ts: Event type re-exports + type guards (isSonosEvent, parseSonosEvent)
 * - messages.ts: Extension messaging types
 */
export * from './api';
export * from './messages';
export * from './events';
