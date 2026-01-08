/**
 * Message Router
 *
 * Provides a typed route registry pattern for message handling.
 * Routes are registered by domain modules and dispatched centrally.
 *
 * Benefits:
 * - Testable: Handlers can be tested in isolation
 * - Discoverable: Easy to find which module handles a message type
 * - Extensible: Adding routes doesn't modify main.ts
 * - Type-safe: Leverages directional message types
 */

import type { z } from 'zod';
import type { BackgroundInboundMessage } from '../lib/messages';

/**
 * Handler function signature for message routes.
 * @param msg - The incoming message
 * @param sender - Chrome message sender information
 * @returns Response to send back (or void for fire-and-forget)
 */
export type RouteHandler<T extends BackgroundInboundMessage = BackgroundInboundMessage> = (
  msg: T,
  sender: chrome.runtime.MessageSender,
) => Promise<unknown> | unknown;

/** Internal route registry mapping message types to handlers */
const routes = new Map<string, RouteHandler>();

/**
 * Registers a handler for a specific message type.
 * @param type - The message type string
 * @param handler - The handler function
 */
export function registerRoute<T extends BackgroundInboundMessage>(
  type: T['type'],
  handler: RouteHandler<T>,
): void {
  if (routes.has(type)) {
    throw new Error(`Route already registered for type: ${type}`);
  }
  routes.set(type, handler as RouteHandler);
}

/**
 * Registers a route with Zod schema validation.
 * The handler receives the validated message type inferred from the schema.
 * @param type - The message type string
 * @param schema - Zod schema for validation
 * @param handler - Handler receiving validated message and sender
 */
export function registerValidatedRoute<S extends z.ZodType<BackgroundInboundMessage>>(
  type: z.infer<S>['type'],
  schema: S,
  handler: (msg: z.infer<S>, sender: chrome.runtime.MessageSender) => Promise<unknown> | unknown,
): void {
  registerRoute(type, (msg, sender) => {
    const validated = schema.parse(msg);
    return handler(validated, sender);
  });
}

/**
 * Dispatches a message to its registered handler.
 * @param msg - The incoming message
 * @param sender - Chrome message sender information
 * @returns Handler response, or undefined if no handler registered
 */
export async function dispatch(
  msg: BackgroundInboundMessage,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  const handler = routes.get(msg.type);
  if (!handler) {
    return undefined;
  }
  return handler(msg, sender);
}

/**
 * Checks if a route is registered for a message type.
 * Useful for debugging and testing.
 * @param type - The message type to check
 * @returns True if a handler is registered
 */
export function hasRoute(type: string): boolean {
  return routes.has(type);
}

/**
 * Gets all registered route types.
 * Useful for debugging and testing.
 * @returns Array of registered message types
 */
export function getRegisteredRoutes(): string[] {
  return Array.from(routes.keys());
}
