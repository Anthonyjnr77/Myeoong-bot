import { logError } from './errors';

/**
 * Retries RPC calls on rate limit (429) with exponential backoff
 * First retry: 500ms, Second: 1000ms, Third: 2000ms
 */
export async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      // Safety: 429 detection
      const is429 = error?.code === 429 ||
                    error?.statusCode === 429 ||
                    error?.message?.includes('429') ||
                    error?.message?.includes('rate limit');

      // Only retry on 429, and not on last attempt
      if (!is429 || attempt === maxRetries - 1) {
        throw error;
      }

      const delay = Math.min(500 * Math.pow(2, attempt), 8000);
      if (process.env.NODE_ENV !== 'test') {
        console.warn(`[RPC] Rate limited, retrying in ${delay}ms (attempt ${attempt + 2}/${maxRetries})`);
      }
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Max retries exceeded');
}
