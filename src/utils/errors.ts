/**
 * Converts any thrown value to an Error object
 */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Logs error with consistent formatting (suppressed in test mode)
 */
export function logError(component: string, message: string, error: unknown): void {
  if (process.env.NODE_ENV === 'test') {
    return; // Silent in test mode
  }
  console.error(`[${component}] ${message}:`, toError(error).message);
}
