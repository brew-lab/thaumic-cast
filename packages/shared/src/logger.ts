/**
 * Supported log levels for the Logger.
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Detects if the current environment is development.
 * Uses Vite's import.meta.env if available.
 */
const isDev = import.meta.env?.MODE === 'development';

/**
 * Structured logger for frontend applications (Desktop & Extension).
 *
 * Provides a consistent way to log messages across different parts of the application
 * with support for scope-based tagging and environment-aware filtering.
 *
 * Behavior:
 * - Development: All logs are printed to console.
 * - Production: 'debug' and 'info' are suppressed unless localStorage.debug === 'true'.
 * - 'warn' and 'error' are always shown regardless of environment.
 */
export class Logger {
  /**
   * The scope/category of this logger instance.
   * Prepended to every log message.
   */
  private scope: string;

  /**
   * Creates a new Logger instance.
   *
   * @param scope - The context name (e.g. 'StreamManager', 'Popup').
   */
  constructor(scope: string) {
    this.scope = scope;
  }

  /**
   * Determines if a message at the given level should be logged.
   *
   * @param level - The log level to check.
   * @returns True if the message should be logged, false otherwise.
   */
  private shouldLog(level: LogLevel): boolean {
    if (isDev) return true;
    if (level === 'warn' || level === 'error') return true;

    // Check for runtime debug flag
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem('debug') === 'true') {
        return true;
      }
    } catch {
      // Ignore errors (e.g. if localStorage is blocked)
    }

    return false;
  }

  /**
   * Formats the log message with the current scope.
   *
   * @param message - The raw log message.
   * @returns The formatted string: "[Scope] Message".
   */
  private formatMessage(message: string): string {
    return `[${this.scope}] ${message}`;
  }

  /**
   * Logs a debug message.
   * Suppressed in production unless the debug flag is set.
   *
   * @param message - The message to log.
   * @param args - Additional data to log.
   */
  debug(message: string, ...args: unknown[]) {
    if (this.shouldLog('debug')) {
      console.debug(this.formatMessage(message), ...args);
    }
  }

  /**
   * Logs an info message.
   * Suppressed in production unless the debug flag is set.
   *
   * @param message - The message to log.
   * @param args - Additional data to log.
   */
  info(message: string, ...args: unknown[]) {
    if (this.shouldLog('info')) {
      console.info(this.formatMessage(message), ...args);
    }
  }

  /**
   * Logs a warning message.
   * Always shown in both development and production.
   *
   * @param message - The message to log.
   * @param args - Additional data to log.
   */
  warn(message: string, ...args: unknown[]) {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage(message), ...args);
    }
  }

  /**
   * Logs an error message.
   * Always shown in both development and production.
   *
   * @param message - The message to log.
   * @param args - Additional data to log.
   */
  error(message: string, ...args: unknown[]) {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage(message), ...args);
    }
  }
}

/**
 * Factory function to create a new logger instance for a specific scope.
 *
 * @param scope - The context name (e.g. 'StreamManager', 'Popup').
 * @returns A new Logger instance.
 */
export function createLogger(scope: string) {
  return new Logger(scope);
}
