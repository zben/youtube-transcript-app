export interface LogContext {
  requestId?: string;
  videoId?: string;
  stage?: string;
  [key: string]: any;
}

function formatPrefix(level: string, context?: LogContext): string {
  const now = new Date().toISOString().substring(11, 23);
  const tags: string[] = [`[${now}]`, `[${level.toUpperCase()}]`];
  if (context?.requestId) tags.push(`[Req:${context.requestId}]`);
  if (context?.videoId) tags.push(`[Video:${context.videoId}]`);
  if (context?.stage) tags.push(`[${context.stage}]`);
  return tags.join(' ');
}

let debugEnabled = true;

/** Set once per runtime entry: Workers has no `process`, so debuggability cannot read env there. */
export function configureLogger(options: { debug?: boolean }): void {
  if (options.debug !== undefined) {
    debugEnabled = options.debug;
  }
}

export const logger = {
  info(message: string, context?: LogContext, data?: any) {
    const prefix = formatPrefix('INFO', context);
    if (data !== undefined) {
      console.log(`${prefix} ${message}`, data);
    } else {
      console.log(`${prefix} ${message}`);
    }
  },

  warn(message: string, context?: LogContext, data?: any) {
    const prefix = formatPrefix('WARN', context);
    if (data !== undefined) {
      console.warn(`${prefix} ⚠️ ${message}`, data);
    } else {
      console.warn(`${prefix} ⚠️ ${message}`);
    }
  },

  error(message: string, err?: any, context?: LogContext) {
    const prefix = formatPrefix('ERROR', context);
    const errDetails = err instanceof Error ? `${err.name}: ${err.message}` : String(err || '');
    console.error(`${prefix} ❌ ${message}:`, errDetails);
    if (err instanceof Error && err.stack) {
      // Print first 4 lines of stack trace for concise debuggability
      const stackLines = err.stack.split('\n').slice(1, 5).join('\n');
      console.error(`${prefix}    Stack:\n${stackLines}`);
    }
  },

  retry(attempt: number, maxAttempts: number, delayMs: number, reason: string, context?: LogContext) {
    const prefix = formatPrefix('RETRY', context);
    console.warn(`${prefix} 🔄 Attempt ${attempt}/${maxAttempts} failed (${reason}). Retrying in ${delayMs}ms...`);
  },

  debug(message: string, context?: LogContext, data?: any) {
    if (debugEnabled) {
      const prefix = formatPrefix('DEBUG', context);
      if (data !== undefined) {
        console.log(`${prefix} 🔍 ${message}`, data);
      } else {
        console.log(`${prefix} 🔍 ${message}`);
      }
    }
  }
};
