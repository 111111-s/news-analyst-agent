/** Errors that are worth retrying (rate limits, timeouts, 5xx, flaky upstreams). */
export class TransientError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TransientError';
  }
}

export interface RetryOptions {
  /** Number of retries after the first attempt. */
  retries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const isTransient = (error: unknown): boolean => error instanceof TransientError;

/** Exponential backoff with a little jitter. `fn` receives the 0-based attempt number. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const isRetryable = options.isRetryable ?? isTransient;
  const wait = options.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= options.retries || !isRetryable(error)) throw error;
      const exp = options.baseDelayMs * 2 ** attempt;
      const delayMs = Math.round(Math.min(options.maxDelayMs ?? 15_000, exp) * (1 + Math.random() * 0.2));
      options.onRetry?.(attempt + 1, error, delayMs);
      await wait(delayMs);
    }
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TransientError(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
