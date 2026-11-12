import { logger, LogContext } from './logger.js';

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  jitter?: boolean;
  retryable?: (error: any) => boolean;
  onRetry?: (attempt: number, delayMs: number, error: any) => void;
  context?: LogContext;
}

export function isTransientNetworkError(err: any): boolean {
  if (!err) return false;

  const msg = (err.message || '').toLowerCase();
  const code = (err.code || err.cause?.code || '').toUpperCase();
  const name = (err.name || '').toLowerCase();

  const networkCodes = [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENOTFOUND',
    'EPIPE',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT'
  ];

  if (networkCodes.includes(code)) return true;

  if (
    msg.includes('fetch failed') ||
    msg.includes('socket hang up') ||
    msg.includes('network error') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    name === 'timeouterror' ||
    name === 'aborterror'
  ) {
    return true;
  }

  // Undici / fetch errors
  if (err.cause && isTransientNetworkError(err.cause)) {
    return true;
  }

  return false;
}

export function isGeminiRetryable(err: any): boolean {
  if (!err) return false;
  if (isTransientNetworkError(err)) return true;

  const status = err.status || err.statusCode || err.code;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }

  const msg = (err.message || '').toLowerCase();
  if (
    msg.includes('resource_exhausted') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('unavailable') ||
    msg.includes('overloaded') ||
    msg.includes('quota') ||
    msg.includes('try again')
  ) {
    return true;
  }

  return false;
}

export function isYouTubeRetryable(err: any): boolean {
  if (!err) return false;
  if (isTransientNetworkError(err)) return true;

  const name = err.name || '';
  const msg = (err.message || '').toLowerCase();

  if (name.includes('TooManyRequest') || msg.includes('too many requests') || msg.includes('429')) {
    return true;
  }

  return false;
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(signal.reason || new Error('Aborted'));
    }

    const timer = setTimeout(() => {
      resolve();
    }, ms);

    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('Aborted'));
    });
  });
}

export async function retryWithBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 10000,
    backoffFactor = 2,
    jitter = true,
    retryable = () => true,
    onRetry,
    context
  } = options;

  let lastError: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (err: any) {
      lastError = err;

      if (attempt >= maxAttempts || !retryable(err)) {
        throw err;
      }

      // Calculate exponential backoff delay with jitter
      let delay = initialDelayMs * Math.pow(backoffFactor, attempt - 1);
      if (jitter) {
        // Full jitter between 0.5 * delay and 1.5 * delay
        delay = delay * (0.5 + Math.random());
      }
      delay = Math.min(delay, maxDelayMs);

      const reason = err?.message || String(err);
      if (onRetry) {
        onRetry(attempt, Math.round(delay), err);
      } else {
        logger.retry(attempt, maxAttempts, Math.round(delay), reason, context);
      }

      await sleep(delay);
    }
  }

  throw lastError;
}
